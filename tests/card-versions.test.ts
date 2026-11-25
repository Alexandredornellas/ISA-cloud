import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Plan } from "@/lib/plan";
import { cardVersions, restoreCardVersion, saveCardVersion, versionChanges } from "@/lib/card-versions";

beforeAll(async () => {
  const c = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(c), { migrationsFolder: "./drizzle" });
  await c.end();
});
beforeEach(async () => {
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
});

const v1: Plan = {
  summary: "NFS8 kickoff",
  projectName: "NFS8",
  people: [],
  requirementChanges: [],
  actions: [
    { type: "jira_create", requirementRef: "R1", summary: "NFS8 game", description: "d", kind: "epic", epicRef: null, jiraProject: "" },
    { type: "jira_create", requirementRef: "R2", summary: "Engine spike", description: "d", kind: "spike", epicRef: "R1", jiraProject: "SCRUM" },
  ],
  openQuestions: ["Which platforms?"],
};
const v2: Plan = {
  ...v1,
  summary: "Moved to NFS8",
  actions: [
    v1.actions[0],
    { ...(v1.actions[1] as Extract<Plan["actions"][number], { type: "jira_create" }>), jiraProject: "NFS8" },
    { type: "slack_message", channel: "C1", recipientLabel: "#needforspeed8", threadTs: null, text: "hi" },
  ],
  openQuestions: [],
};

describe("card versions", () => {
  it("says what changed between versions", () => {
    expect(versionChanges(v1, v2)).toEqual([
      "Create spike: Engine spike: SCRUM → NFS8",
      "Added: Slack #needforspeed8",
      "1 open question answered or dropped",
    ]);
  });

  it("keeps the first draft, records each change with its reason, and goes back to an earlier version", async () => {
    const [p] = await db.insert(schema.proposals).values({ kind: "new_project", title: "t", plan: v1 }).returning();
    expect(await saveCardVersion(p.id, v1, v2, { cause: "jira_project", reason: "You set NFS8." })).toBe(2);
    let row = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(row?.plan.summary).toBe("Moved to NFS8");

    expect(await restoreCardVersion(p.id, 1)).toEqual({ ok: true, version: 3 });
    row = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(row?.plan).toEqual(v1);
    const versions = (await cardVersions([p.id])).get(p.id)!;
    expect(versions.map((v) => [v.version, v.cause, v.reason])).toEqual([
      [1, "drafted", "ISA's first draft."],
      [2, "jira_project", "You set NFS8."],
      [3, "restored", "You went back to version 1."],
    ]);

    await db.update(schema.proposals).set({ status: "executed" }).where(eq(schema.proposals.id, p.id));
    expect((await restoreCardVersion(p.id, 2)).ok).toBe(false);
  });
});
