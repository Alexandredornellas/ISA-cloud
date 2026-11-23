import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { executeProposal, recordMemory } from "@/lib/executor";
import type { JiraClient } from "@/lib/jira";
import type { Plan } from "@/lib/plan";
import { decisionTrail } from "@/lib/trail";

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

const plan = (over: Partial<Plan>): Plan => ({ summary: "s", projectName: null, people: [], requirementChanges: [], actions: [], openQuestions: [], ...over });
const tiers = { ref: "R1", op: "create" as const, title: "Rate limits per tier", description: "Enterprise 1,000/min", status: "proposed" as const, approvedBy: null, reason: "Priya by email" };

async function setup(p: Plan) {
  const [project] = await db.insert(schema.projects).values({ name: "Partner API" }).returning();
  const [proposal] = await db.insert(schema.proposals).values({ kind: "update", projectId: project.id, title: "t", plan: p }).returning();
  return { project, proposal };
}

const reqs = (projectId: string) => db.select().from(schema.requirements).where(eq(schema.requirements.projectId, projectId));
const get = (id: string) => db.query.proposals.findFirst({ where: eq(schema.proposals.id, id) });

describe("memory on filing", () => {
  it("saves requirements and people right away; the Jira steps stay optional", async () => {
    const { project, proposal } = await setup(
      plan({
        requirementChanges: [tiers],
        people: [{ name: "Priya Nair", email: "priya@x.example", slackUserId: null, role: "Partner integrations" }],
        actions: [{ type: "jira_create", requirementRef: "R1", summary: "Rate limits", description: "d", kind: "story", epicRef: null }],
      }),
    );
    await recordMemory(proposal.id);
    const [req] = await reqs(project.id);
    expect([req.title, req.status]).toEqual(["Rate limits per tier", "proposed"]);
    const after = await get(proposal.id);
    expect(after?.status).toBe("pending");
    expect(after?.refs).toEqual({ R1: req.id });
    expect((await db.query.projects.findFirst({ where: eq(schema.projects.id, project.id) }))?.people.map((p) => p.name)).toEqual(["Priya Nair"]);
    // On the trail it is on record, not waiting.
    expect((await decisionTrail(req.id))!.entries.map((e) => [e.kind, e.reason])).toEqual([["decided", "Priya by email"]]);

    // Approving the optional step creates the ticket on the same requirement, without a duplicate.
    const calls: string[] = [];
    const jira = { createIssue: async (i: { summary: string }) => (calls.push(i.summary), { key: "API-20", url: "u" }) } as unknown as JiraClient;
    await executeProposal(proposal.id, { jira, slack: null, email: null });
    const after2 = await reqs(project.id);
    expect(after2.map((r) => [r.title, r.jiraIssueKey])).toEqual([["Rate limits per tier", "API-20"]]);
    expect(calls).toEqual(["Rate limits"]);
  });

  it("closes a draft that has nothing to do outside ISA", async () => {
    const { project, proposal } = await setup(plan({ requirementChanges: [tiers] }));
    await recordMemory(proposal.id);
    expect((await get(proposal.id))?.status).toBe("executed");
    expect(await reqs(project.id)).toHaveLength(1);
  });

  it("updates instead of duplicating when a draft is merged with newer items", async () => {
    const { project, proposal } = await setup(plan({ requirementChanges: [tiers], actions: [{ type: "jira_comment", requirementRef: "R1", issueKey: "API-1", body: "b" }] }));
    await recordMemory(proposal.id);
    await db
      .update(schema.proposals)
      .set({ plan: plan({ requirementChanges: [{ ...tiers, description: "Enterprise 2,000/min", status: "approved", approvedBy: "Priya" }], actions: [{ type: "jira_comment", requirementRef: "R1", issueKey: "API-1", body: "b" }] }) })
      .where(eq(schema.proposals.id, proposal.id));
    await recordMemory(proposal.id);
    const rows = await reqs(project.id);
    expect(rows.map((r) => [r.description, r.status, r.approvedBy])).toEqual([["Enterprise 2,000/min", "approved", "Priya"]]);
  });
});
