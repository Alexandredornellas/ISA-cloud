import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { blankBackups, startBlank } from "@/lib/reset";

const made: string[] = [];
beforeAll(async () => {
  const c = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(c), { migrationsFolder: "./drizzle" });
  await c.end();
});
afterAll(async () => {
  for (const s of made) await db.execute(sql.raw(`drop schema "${s}" cascade`));
});

describe("start blank", () => {
  it("empties the memory, keeps connections and settings, and backs everything up first", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Blank test" }).returning();
    await db.insert(schema.requirements).values({ projectId: project.id, title: "Keep in backup" });
    await db.insert(schema.workerState).values({ key: "blank-test", value: { a: "1" } }).onConflictDoNothing();

    const { backup } = await startBlank(new Date("2031-01-02T03:04:05Z"));
    made.push(backup);
    expect(backup).toBe("backup_20310102_030405");
    expect(await db.select().from(schema.projects)).toHaveLength(0);
    expect(await db.select().from(schema.requirements)).toHaveLength(0);
    expect((await db.query.workerState.findFirst({ where: (w, { eq }) => eq(w.key, "blank-test") }))?.value).toEqual({ a: "1" });
    const saved = await db.execute<{ title: string }>(sql.raw(`select title from "${backup}".requirements`));
    expect([...saved].map((r) => r.title)).toContain("Keep in backup");
    expect(await blankBackups()).toContain(backup);
    await db.delete(schema.workerState).where(sql`key = 'blank-test'`);
  });
});
