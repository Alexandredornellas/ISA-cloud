import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { liveStamp } from "@/lib/live";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.jiraTickets);
  await db.delete(schema.events);
  await db.delete(schema.workerState);
});

describe("liveStamp", () => {
  it("stays the same when nothing changed", async () => {
    expect(await liveStamp()).toBe(await liveStamp());
  });

  it("changes when a new item arrives, is updated or removed", async () => {
    const before = await liveStamp();
    const [e] = await db.insert(schema.events).values({ source: "slack", externalId: "live-1", title: "New ask", occurredAt: new Date(), content: "c" }).returning();
    const added = await liveStamp();
    expect(added).not.toBe(before);

    await db.update(schema.events).set({ status: "sorted", updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.events.id, e.id));
    const updated = await liveStamp();
    expect(updated).not.toBe(added);

    await db.delete(schema.events).where(eq(schema.events.id, e.id));
    expect(await liveStamp()).not.toBe(updated);
  });

  it("ignores the worker's own bookkeeping and Jira re-syncs with no Jira change", async () => {
    await db.insert(schema.jiraTickets).values({ key: "SCRUM-1", jiraUpdatedAt: new Date("2026-11-01") });
    const before = await liveStamp();
    await db.insert(schema.workerState).values({ key: "slack-cursors", value: {} });
    await db.update(schema.jiraTickets).set({ updatedAt: new Date() }).where(eq(schema.jiraTickets.key, "SCRUM-1"));
    expect(await liveStamp()).toBe(before);

    await db.update(schema.jiraTickets).set({ jiraUpdatedAt: new Date("2026-11-02") }).where(eq(schema.jiraTickets.key, "SCRUM-1"));
    expect(await liveStamp()).not.toBe(before);
  });
});
