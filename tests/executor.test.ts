import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { executeProposal, type Senders } from "@/lib/executor";
import type { JiraClient } from "@/lib/jira";
import type { Plan } from "@/lib/plan";

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

function fakeJira() {
  let n = 0;
  const calls: string[] = [];
  const jira = {
    issueUrl: (key: string) => `https://x/browse/${key}`,
    createIssue: async (i: { summary: string }) => {
      n += 1;
      calls.push(`create:${i.summary}`);
      return { key: `ISA-${n}`, url: `https://x/browse/ISA-${n}` };
    },
    updateIssue: async (key: string) => {
      calls.push(`update:${key}`);
    },
    addComment: async (key: string, body: string) => {
      calls.push(`comment:${key}:${body}`);
    },
  } as unknown as JiraClient;
  return { jira, calls };
}

const newProjectPlan: Plan = {
  summary: "Login page with MFA",
  projectName: "Login",
  requirementChanges: [
    { ref: "R1", op: "create", title: "Password sign-in", description: "", status: "approved", approvedBy: "Ana", reason: "" },
    { ref: "R2", op: "create", title: "MFA code", description: "", status: "proposed", approvedBy: null, reason: "" },
  ],
  actions: [
    { type: "jira_create", requirementRef: "R1", summary: "Password sign-in", description: "d", issueType: "Story" },
    { type: "jira_create", requirementRef: "R2", summary: "MFA code", description: "d", issueType: "Story" },
    { type: "jira_comment", requirementRef: "R2", issueKey: null, body: "Waiting on approval" },
  ],
  openQuestions: [],
};

async function addProposal(values: Partial<typeof schema.proposals.$inferInsert> & { plan: Plan }) {
  const [p] = await db
    .insert(schema.proposals)
    .values({ kind: "new_project", title: "t", ...values })
    .returning();
  return p;
}

describe("executeProposal", () => {
  it("creates the project, requirements and linked Jira issues", async () => {
    const { jira, calls } = fakeJira();
    const p = await addProposal({ plan: newProjectPlan });
    const senders: Senders = { jira, slack: null, email: null };

    const result = await executeProposal(p.id, senders);

    expect(result.ok).toBe(true);
    const reqs = await db.query.requirements.findMany({ where: eq(schema.requirements.projectId, result.projectId) });
    expect(reqs.map((r) => [r.title, r.jiraIssueKey]).sort()).toEqual([
      ["MFA code", "ISA-2"],
      ["Password sign-in", "ISA-1"],
    ]);
    // The comment resolved its issue key from the ticket created earlier in the same plan.
    expect(calls).toContain("comment:ISA-2:Waiting on approval");
    const saved = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(saved?.status).toBe("executed");
    expect(saved?.projectId).toBe(result.projectId);
  });

  it("updates an existing requirement's ticket by requirement id", async () => {
    const { jira, calls } = fakeJira();
    const first = await executeProposal((await addProposal({ plan: newProjectPlan })).id, { jira, slack: null, email: null });
    const mfa = await db.query.requirements.findFirst({ where: eq(schema.requirements.title, "MFA code") });

    const change = await addProposal({
      kind: "update",
      projectId: first.projectId,
      plan: {
        summary: "MFA approved over Slack",
        projectName: null,
        requirementChanges: [
          { ref: mfa!.id, op: "update", title: "MFA code", description: "SMS allowed", status: "approved", approvedBy: "Bo", reason: "" },
        ],
        actions: [{ type: "jira_update", requirementRef: mfa!.id, issueKey: null, summary: null, description: "SMS allowed" }],
        openQuestions: [],
      },
    });
    const result = await executeProposal(change.id, { jira, slack: null, email: null });

    expect(result.ok).toBe(true);
    expect(calls).toContain("update:ISA-2");
    const updated = await db.query.requirements.findFirst({ where: eq(schema.requirements.id, mfa!.id) });
    expect(updated?.approvedBy).toBe("Bo");
    expect(updated?.status).toBe("approved");
  });

  it("logs a failed action and still runs the rest", async () => {
    const { jira } = fakeJira();
    const p = await addProposal({
      plan: {
        ...newProjectPlan,
        actions: [
          { type: "slack_message", channel: "C1", recipientLabel: "#team", threadTs: null, text: "hi" },
          newProjectPlan.actions[0],
        ],
      },
    });
    const result = await executeProposal(p.id, { jira, slack: null, email: null });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Slack is not connected"]);
    const rows = await db.query.actions.findMany({ where: eq(schema.actions.proposalId, p.id) });
    expect(rows.map((r) => r.status).sort()).toEqual(["done", "failed"]);
    const saved = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(saved?.status).toBe("failed");
  });

  it("refuses to run a proposal twice", async () => {
    const { jira } = fakeJira();
    const p = await addProposal({ plan: newProjectPlan });
    await executeProposal(p.id, { jira, slack: null, email: null });
    await expect(executeProposal(p.id, { jira, slack: null, email: null })).rejects.toThrow(/already/);
  });
});

describe("retryFailedActions", () => {
  it("re-runs failed actions once the service is connected", async () => {
    const p = await addProposal({ plan: newProjectPlan });
    const first = await executeProposal(p.id, { jira: null, slack: null, email: null });
    expect(first.ok).toBe(false);

    const { jira, calls } = fakeJira();
    const { retryFailedActions } = await import("@/lib/executor");
    const second = await retryFailedActions(p.id, { jira, slack: null, email: null });

    expect(second.ok).toBe(true);
    // The comment on R2 resolved through the stored ref map to the ticket created on retry.
    expect(calls).toEqual(["create:Password sign-in", "create:MFA code", "comment:ISA-2:Waiting on approval"]);
    const saved = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(saved?.status).toBe("executed");
    expect(saved?.error).toBeNull();
  });
});
