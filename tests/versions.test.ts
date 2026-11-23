import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordMemory } from "@/lib/executor";
import type { Plan, RequirementChange } from "@/lib/plan";
import { decisionTrail } from "@/lib/trail";
import { recordVersion, versionAt, versionsOf } from "@/lib/versions";
import { chatTools } from "@/lib/brain/chat-tools";
import type { StructuredLLM } from "@/lib/brain/llm";

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

const plan = (changes: RequirementChange[]): Plan => ({ summary: "s", projectName: null, people: [], requirementChanges: changes, actions: [], openQuestions: [] });
const change = (over: Partial<RequirementChange>): RequirementChange => ({
  ref: "R1",
  op: "create",
  title: "Pix at checkout",
  description: "Pay with Pix",
  status: "proposed",
  approvedBy: null,
  reason: "Ana in the kickoff",
  ...over,
});

async function file(projectId: string, changes: RequirementChange[]) {
  const [p] = await db.insert(schema.proposals).values({ kind: "update", projectId, title: "t", plan: plan(changes) }).returning();
  await recordMemory(p.id);
  return p;
}

describe("requirement versions", () => {
  it("keeps every version, with what it said, when and why, through a drop", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    await file(project.id, [change({})]);
    const [req] = await db.select().from(schema.requirements).where(eq(schema.requirements.projectId, project.id));
    await file(project.id, [change({ ref: req.id, op: "update", description: "Pix and cards", status: "approved", approvedBy: "Ana", reason: "Bruno on Slack" })]);
    await file(project.id, [change({ ref: req.id, op: "drop", description: "Pix and cards", reason: "Legal blocked Pix for now" })]);

    const vs = await versionsOf(req.id);
    expect(vs.map((v) => [v.version, v.description, v.status, v.reason])).toEqual([
      [1, "Pay with Pix", "proposed", "Ana in the kickoff"],
      [2, "Pix and cards", "approved", "Bruno on Slack"],
      [3, "Pix and cards", "dropped", "Legal blocked Pix for now"],
    ]);
    // Each version is closed when the next one opens; only the last is open.
    expect(vs[0].validTo?.getTime()).toBe(vs[1].validFrom.getTime());
    expect(vs[2].validTo).toBeNull();
    expect((await versionAt(req.id, vs[1].validFrom))?.version).toBe(2);
    expect(await versionAt(req.id, new Date(vs[0].validFrom.getTime() - 1000))).toBeNull();

    // The trail shows what each step changed.
    const t = (await decisionTrail(req.id))!;
    const changes = t.entries.map((e) => e.change && [e.change.was?.description ?? null, e.change.now.status]);
    expect(changes).toEqual([[null, "proposed"], ["Pay with Pix", "approved"], ["Pix and cards", "dropped"]]);
    expect(t.versions).toHaveLength(3);
  });

  it("rebuilds the history of a requirement saved before versions existed", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    const [req] = await db.insert(schema.requirements).values({ projectId: project.id, title: "Guest checkout", description: "No login", status: "approved" }).returning();
    await db.insert(schema.proposals).values({
      kind: "update",
      projectId: project.id,
      title: "t",
      status: "executed",
      refs: { R1: req.id },
      plan: plan([change({ title: "Guest checkout", description: "No login", status: "approved", reason: "Kickoff" })]),
    });
    // Then someone edits it by hand.
    const before = req;
    const [after] = await db.update(schema.requirements).set({ status: "done" }).where(eq(schema.requirements.id, req.id)).returning();
    await recordVersion(after, { changedBy: "you", reason: "Status set to done by hand" }, before);
    expect((await versionsOf(req.id)).map((v) => [v.version, v.status, v.changedBy, v.reason])).toEqual([
      [1, "approved", "ISA", "Kickoff"],
      [2, "done", "you", "Status set to done by hand"],
    ]);
    // Recording the same state again adds nothing.
    expect(await recordVersion(after, { changedBy: "you" }, after)).toBeNull();
  });

  it("starts a requirement with no records at its current state", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    const [req] = await db.insert(schema.requirements).values({ projectId: project.id, title: "Old one", status: "proposed" }).returning();
    expect((await versionsOf(req.id)).map((v) => [v.version, v.reason])).toEqual([[1, "Recorded before ISA kept versions"]]);
  });
});

describe("searching items", () => {
  it("leaves out items marked as not relevant unless asked", async () => {
    await db.insert(schema.events).values([
      { source: "gmail", externalId: "a", title: "Pix launch", content: "Pix goes live", occurredAt: new Date(), status: "sorted" },
      { source: "gmail", externalId: "b", title: "Pix newsletter", content: "Pix trends", occurredAt: new Date(), status: "ignored" },
    ]);
    const llm: StructuredLLM = async () => ({}) as never;
    const search = chatTools(llm).find((t) => t.name === "search_items")!;
    const out = String(await search.run({ query: "Pix", includeIgnored: null } as never));
    expect(out).toContain("Pix launch");
    expect(out).not.toContain("Pix newsletter");
    expect(String(await search.run({ query: "Pix", includeIgnored: true } as never))).toContain("Pix newsletter");
  });
});
