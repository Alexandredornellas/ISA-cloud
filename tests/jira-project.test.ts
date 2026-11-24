import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { executeProposal } from "@/lib/executor";
import type { JiraClient } from "@/lib/jira";
import type { Plan } from "@/lib/plan";
import { jiraKeyFor, setJiraKey } from "@/lib/jira-project";

beforeAll(async () => {
  const c = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(c), { migrationsFolder: "./drizzle" });
  await c.end();
});
beforeEach(async () => {
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
});

const plan: Plan = {
  summary: "s",
  projectName: null,
  people: [],
  requirementChanges: [{ ref: "R1", op: "create", title: "Pix", description: "d", status: "approved", approvedBy: null, reason: "r" }],
  actions: [
    { type: "jira_create", requirementRef: "R1", summary: "Pix", description: "d", kind: "story", epicRef: null, details: { sprint: "Sprint 7", storyPoints: null, links: [], extra: [] } },
  ],
  openQuestions: [],
};

describe("Jira project per ISA project", () => {
  it("creates tickets and picks sprints in the project's own Jira project", async () => {
    process.env.JIRA_PROJECT_KEY = "SCRUM";
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    expect(await jiraKeyFor(project.id)).toBe("SCRUM");
    expect(await setJiraKey(project.id, "chk")).toEqual({ ok: true, key: "CHK" });
    expect((await setJiraKey(project.id, "not a key")).ok).toBe(false);

    const calls: string[] = [];
    const jira = {
      createIssue: async (i: { projectKey?: string }) => (calls.push(`create ${i.projectKey}`), { key: "CHK-1", url: "u" }),
      openSprints: async (k: string) => (calls.push(`sprints ${k}`), [{ id: 7, name: "Sprint 7", state: "active" }]),
      moveToSprint: async (key: string, id: number) => calls.push(`move ${key} ${id}`),
    } as unknown as JiraClient;
    const [p] = await db.insert(schema.proposals).values({ kind: "update", projectId: project.id, title: "t", plan }).returning();
    const r = await executeProposal(p.id, { jira, slack: null, email: null });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["create CHK", "sprints CHK", "move CHK-1 7"]);

    // Cleared, it learns from where the project's tickets live (CHK-1 now), else the default.
    await setJiraKey(project.id, "");
    expect(await jiraKeyFor(project.id)).toBe("CHK");
    const [empty] = await db.insert(schema.projects).values({ name: "Empty" }).returning();
    expect(await jiraKeyFor(empty.id)).toBe("SCRUM");
  });

  it("creates a ticket in the Jira project ISA chose for it", async () => {
    process.env.JIRA_PROJECT_KEY = "SCRUM";
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    const calls: string[] = [];
    const jira = { createIssue: async (i: { projectKey?: string }) => (calls.push(`create ${i.projectKey}`), { key: "PAY-3", url: "u" }) } as unknown as JiraClient;
    const chosen: Plan = { ...plan, actions: [{ ...plan.actions[0], details: null, jiraProject: "PAY" } as Plan["actions"][number]] };
    const [p] = await db.insert(schema.proposals).values({ kind: "update", projectId: project.id, title: "t", plan: chosen }).returning();
    await executeProposal(p.id, { jira, slack: null, email: null });
    expect(calls).toEqual(["create PAY"]);
  });
});
