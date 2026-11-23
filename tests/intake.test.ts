import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { ignoreEvent, intakeCounts, intakeItems, unfileEvent } from "@/lib/intake";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

const empty = { summary: "", projectName: null, people: [], requirementChanges: [], actions: [], openQuestions: [] };

async function setup() {
  const [a] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
  const [b] = await db.insert(schema.projects).values({ name: "Partner API" }).returning();
  const mk = (title: string, status: "sorted" | "unsure" | "ignored", minutesAgo: number) =>
    db.insert(schema.events).values({ source: "zoom", externalId: crypto.randomUUID(), title, occurredAt: new Date(Date.now() - minutesAgo * 60000), content: "…", status }).returning().then((r) => r[0]);
  const sync = await mk("Product sync", "sorted", 30);
  const mail = await mk("Launch date", "unsure", 10);
  await mk("Newsletter", "ignored", 20);
  await db.insert(schema.eventProjects).values([
    { eventId: sync.id, projectId: a.id, relation: "context", note: "Pix still blocked" },
    { eventId: sync.id, projectId: b.id, relation: "change", note: "Webhooks ready" },
  ]);
  const [q] = await db.insert(schema.proposals).values({ kind: "clarify", projectId: b.id, title: "Where?", plan: { ...empty, summary: "Maybe the API launch" }, eventIds: [mail.id] }).returning();
  const [draft] = await db.insert(schema.proposals).values({ kind: "update", projectId: a.id, title: "Draft", plan: empty, eventIds: [sync.id] }).returning();
  return { a, b, sync, mail, q, draft };
}

describe("intake queue", () => {
  it("shows each item with every project it went to, its part, and open questions", async () => {
    const { q } = await setup();
    const all = await intakeItems("all");
    expect(all.map((i) => [i.title, i.status])).toEqual([["Launch date", "unsure"], ["Newsletter", "ignored"], ["Product sync", "sorted"]]);
    expect(all[2].projects.map((p) => [p.name, p.note]).sort()).toEqual([["Checkout", "Pix still blocked"], ["Partner API", "Webhooks ready"]]);
    expect(all[0].questions).toEqual([{ proposalId: q.id, projectId: q.projectId, projectName: "Partner API", reason: "Maybe the API launch" }]);
    expect((await intakeItems("needs_you")).map((i) => i.title)).toEqual(["Launch date"]);
    expect(await intakeCounts()).toEqual({ all: 3, needs_you: 1, filed: 1, ignored: 1, failed: 0 });
  });

  it("takes an item off one project, keeping the others, and ignores it when none is left", async () => {
    const { a, b, sync, draft } = await setup();
    await unfileEvent(sync.id, a.id);
    let [item] = (await intakeItems("filed")).filter((i) => i.id === sync.id);
    expect(item.projects.map((p) => p.name)).toEqual(["Partner API"]);
    expect((await db.query.proposals.findFirst({ where: (p, { eq }) => eq(p.id, draft.id) }))?.status).toBe("dismissed");
    await unfileEvent(sync.id, b.id);
    [item] = (await intakeItems("ignored")).filter((i) => i.id === sync.id);
    expect(item.status).toBe("ignored");
  });

  it("ignoring an item drops its question", async () => {
    const { mail, q } = await setup();
    await ignoreEvent(mail.id);
    expect((await db.query.proposals.findFirst({ where: (p, { eq }) => eq(p.id, q.id) }))?.status).toBe("dismissed");
    expect(await intakeItems("needs_you")).toEqual([]);
  });
});
