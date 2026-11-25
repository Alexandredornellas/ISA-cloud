import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { executeProposal } from "@/lib/executor";
import type { JiraClient } from "@/lib/jira";
import { eq } from "drizzle-orm";
import { fromDraft, type Plan } from "@/lib/plan";
import { applyChoices } from "@/lib/choices";
import { useJiraSearcher } from "@/lib/jira-research";
import { adoptJiraProject, jiraKeyFor, moveToJiraProject, setJiraKey } from "@/lib/jira-project";

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

describe("suggesting a new Jira project", () => {
  const waiting: Plan = {
    ...plan,
    newJiraProject: { key: "NFS8", name: "Need for Speed 8", template: "scrum", reason: "No project is about this game." },
    actions: [
      { type: "jira_create", requirementRef: "R1", summary: "NFS8", description: "d", kind: "epic", epicRef: null, jiraProject: "NFS8" },
      { type: "jira_create", requirementRef: "R2", summary: "Engine spike", description: "d", kind: "spike", epicRef: "R1", jiraProject: "NFS8" },
      { type: "jira_create", requirementRef: "R3", summary: "Other", description: "d", kind: "story", epicRef: null, jiraProject: "SCRUM" },
    ],
  };

  it("keeps a valid suggestion from a draft and drops an empty one", () => {
    const draft = { ...waiting, projectName: "", people: [], requirementChanges: [], newJiraProject: { key: " nfs8 ", name: "", template: "scrum" as const, reason: "r" }, actions: [] };
    expect(fromDraft(draft).newJiraProject).toEqual({ key: "NFS8", name: "NFS8", template: "scrum", reason: "r" });
    expect(fromDraft({ ...draft, newJiraProject: { key: "", name: "", template: "scrum", reason: "" } }).newJiraProject).toBeNull();
  });

  it("turns the draft's empty strings back into nulls", () => {
    const out = fromDraft({
      summary: "s",
      openQuestions: [],
      projectName: "",
      people: [{ name: "Bruno", email: "", slackUserId: "U1", role: "" }],
      requirementChanges: [{ ref: "R1", op: "create", title: "t", description: "d", status: "proposed", approvedBy: "", reason: "r", epic: "" }],
      newJiraProject: { key: "", name: "", template: "scrum", reason: "" },
      actions: [
        { type: "jira_create", requirementRef: "R1", summary: "S", description: "d", kind: "story", epicRef: "", jiraProject: "chk" },
        { type: "jira_update", requirementRef: "R1", issueKey: "CHK-1", summary: "", description: "new" },
        { type: "slack_message", channel: "C1", recipientLabel: "#x", threadTs: "", text: "hi" },
        { type: "email", to: ["a@b.c"], subject: "s", body: "b", threadId: "" },
      ],
    });
    expect(out.projectName).toBeNull();
    expect(out.people[0]).toEqual({ name: "Bruno", email: null, slackUserId: "U1", role: null });
    expect(out.requirementChanges[0].approvedBy).toBeNull();
    expect(out.actions).toMatchObject([
      { type: "jira_create", epicRef: null, jiraProject: "CHK" },
      { type: "jira_update", issueKey: "CHK-1", summary: null, description: "new" },
      { type: "slack_message", threadTs: null },
      { type: "email", threadId: null },
    ]);
  });

  it("moves only the waiting tickets once the owner gives the key", () => {
    const { plan: moved, moved: n } = moveToJiraProject(waiting, "NFS");
    expect(n).toBe(2);
    expect(moved.newJiraProject).toBeNull();
    expect(moved.actions.map((a) => (a.type === "jira_create" ? a.jiraProject : null))).toEqual(["NFS", "NFS", "SCRUM"]);
  });

  it("lets the owner pick another project per step on the card", () => {
    const chosen = applyChoices(waiting, { keep: [0, 1, 2], projects: { 0: "be", 1: "BE", 2: "not a key!" } });
    expect(chosen.actions.map((a) => (a.type === "jira_create" ? a.jiraProject : null))).toEqual(["BE", "BE", "SCRUM"]);
    expect(chosen.newJiraProject).toBeNull();
    expect(applyChoices(waiting, { keep: [0, 1, 2] }).newJiraProject?.key).toBe("NFS8");
  });

  it("checks Jira can see the new project, then moves the card and sets the ISA project's key", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "NFS8" }).returning();
    const [p] = await db.insert(schema.proposals).values({ kind: "new_project", projectId: project.id, title: "t", plan: waiting }).returning();
    let visible = [{ key: "SCRUM", name: "ISA" }];
    useJiraSearcher({ listProjects: async () => visible } as unknown as JiraClient);
    try {
      const notYet = await adoptJiraProject("NFS8", { proposalId: p.id });
      expect(notYet.ok).toBe(false);
      visible = [...visible, { key: "NFS8", name: "Need for Speed 8" }];
      expect(await adoptJiraProject("nfs8", { proposalId: p.id })).toEqual({ ok: true, key: "NFS8", moved: 1 });
      const after = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
      expect(after?.plan.newJiraProject).toBeNull();
      expect(await jiraKeyFor(project.id)).toBe("NFS8");
    } finally {
      useJiraSearcher(undefined);
    }
  });

  it("moves a waiting card's tickets that went to the old project when the owner sets a new one", async () => {
    process.env.JIRA_PROJECT_KEY = "SCRUM";
    const [project] = await db.insert(schema.projects).values({ name: "NFS8" }).returning();
    const old: Plan = {
      ...waiting,
      newJiraProject: null,
      actions: [
        { type: "jira_create", requirementRef: "R1", summary: "NFS8", description: "d", kind: "epic", epicRef: null, jiraProject: "" },
        { type: "jira_create", requirementRef: "R2", summary: "Engine spike", description: "d", kind: "spike", epicRef: "R1", jiraProject: "SCRUM" },
        { type: "jira_create", requirementRef: "R3", summary: "Pay", description: "d", kind: "story", epicRef: null, jiraProject: "PAY" },
      ],
    };
    const [p] = await db.insert(schema.proposals).values({ kind: "new_project", projectId: project.id, title: "t", plan: old }).returning();
    useJiraSearcher({ listProjects: async () => [{ key: "SCRUM", name: "ISA" }, { key: "PAY", name: "P" }, { key: "NFS8", name: "N" }] } as unknown as JiraClient);
    try {
      expect(await adoptJiraProject("NFS8", { projectId: project.id })).toEqual({ ok: true, key: "NFS8", moved: 1 });
      const after = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
      // "" follows the project's setting (now NFS8); PAY was ISA's own pick and stays.
      expect(after?.plan.actions.map((a) => (a.type === "jira_create" ? a.jiraProject : null))).toEqual(["", "NFS8", "PAY"]);
      expect(await jiraKeyFor(project.id)).toBe("NFS8");
    } finally {
      useJiraSearcher(undefined);
    }
  });
});

describe("searching Jira term by term", () => {
  it("takes turns between terms so a broad term can't crowd out a narrow one", async () => {
    const { searchEachTerm } = await import("@/lib/jira-research");
    const t = (key: string) => ({ key, issueType: null, summary: key, description: "", status: null, assignee: null, sprint: null, epic: null, labels: [], updated: null, url: "", comments: [] });
    const results: Record<string, ReturnType<typeof t>[]> = {
      checkout: ["CHK-1", "CHK-2", "CHK-3", "CHK-4", "CHK-5"].map(t),
      Pix: ["PAY-1", "PAY-2", "CHK-1"].map(t),
    };
    const found = await searchEachTerm({ searchText: async ([term]) => results[term] ?? [] }, ["checkout", "Pix"], 4);
    expect(found.map((f) => f.key)).toEqual(["CHK-1", "PAY-1", "CHK-2", "PAY-2"]);
  });
});

describe("naming a ticket's epic", () => {
  it("names an epic created in the same plan instead of showing its id", async () => {
    const { describeAction } = await import("@/lib/plan");
    const epic = { type: "jira_create" as const, requirementRef: "2b4f5ae4-d171", summary: "Pix at checkout", description: "d", kind: "epic" as const, epicRef: null, jiraProject: "CHK" };
    const story = { ...epic, requirementRef: "R2", summary: "Pay with Pix", kind: "story" as const, epicRef: "2b4f5ae4-d171" };
    expect(describeAction(story, { actions: [epic, story] })).toBe('Create story in CHK: Pay with Pix (under the epic "Pix at checkout")');
    expect(describeAction(story)).toBe("Create story in CHK: Pay with Pix (under an epic)");
    expect(describeAction({ ...story, epicRef: "PAY-1" })).toBe("Create story in CHK: Pay with Pix (under epic PAY-1)");
  });
});
