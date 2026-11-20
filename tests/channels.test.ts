import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { applyChoices } from "@/lib/choices";
import { channels, decisions, notifications } from "@/lib/channels";
import type { Plan } from "@/lib/plan";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.proposals);
  await db.delete(schema.jiraTickets);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

const plan: Plan = {
  summary: "Password reset needs its own epic",
  projectName: null,
  people: [],
  requirementChanges: [
    { ref: "R1", op: "create", title: "Account recovery", description: "", status: "proposed", approvedBy: null, reason: "" },
    { ref: "R2", op: "create", title: "Reset by email", description: "", status: "proposed", approvedBy: null, reason: "" },
  ],
  actions: [
    { type: "jira_create", requirementRef: "R1", summary: "Account recovery", description: "", kind: "epic", epicRef: null },
    { type: "jira_create", requirementRef: "R2", summary: "Reset by email", description: "", kind: "story", epicRef: "R1" },
    { type: "slack_message", channel: "C1", threadTs: null, recipientLabel: "#login", text: "Planned" },
  ],
  openQuestions: [],
};

describe("applyChoices", () => {
  it("keeps only the ticked steps", () => {
    const out = applyChoices(plan, { keep: [0, 1] });
    expect(out.actions.map((a) => a.type)).toEqual(["jira_create", "jira_create"]);
  });

  it("renames the new epic", () => {
    const out = applyChoices(plan, { keep: [0, 1, 2], epic: { mode: "new", name: "Password reset" } });
    expect(out.actions[0]).toMatchObject({ kind: "epic", summary: "Password reset" });
  });

  it("puts the stories under an existing epic instead, and drops the epic's own requirement", () => {
    const out = applyChoices(plan, { keep: [0, 1, 2], epic: { mode: "existing", key: "SCRUM-1" } });
    expect(out.actions.some((a) => a.type === "jira_create" && a.kind === "epic")).toBe(false);
    expect(out.actions[0]).toMatchObject({ summary: "Reset by email", epicRef: "SCRUM-1" });
    expect(out.requirementChanges.map((r) => r.ref)).toEqual(["R2"]);
  });

  it("does not leave a story pointing at an epic that was unticked", () => {
    const out = applyChoices(plan, { keep: [1] });
    expect(out.actions[0]).toMatchObject({ summary: "Reset by email", epicRef: null });
  });
});

describe("channels", () => {
  it("counts what needs the owner per project, and sends unclear items to General", async () => {
    const [a, b] = await db.insert(schema.projects).values([{ name: "Login" }, { name: "Billing" }]).returning();
    const [e] = await db.insert(schema.events).values({ source: "gmail", externalId: "x", title: "Audit logs", author: "Rafael", occurredAt: new Date(), content: "c" }).returning();
    await db.insert(schema.proposals).values([
      { kind: "update", projectId: a.id, title: "Changes on Login", plan, eventIds: [e.id] },
      { kind: "update", projectId: a.id, title: "Old", plan, eventIds: [], status: "dismissed", decidedAt: new Date() },
      { kind: "clarify", projectId: b.id, title: 'Is "Audit logs" about Billing?', plan: { ...plan, actions: [] }, eventIds: [e.id] },
    ]);
    await db.insert(schema.jiraTickets).values({ key: "SCRUM-1", projectId: a.id, issueType: "Épico", summary: "Sign-in" });

    const list = await channels();
    expect(list[0]).toMatchObject({ name: "General", count: 1 });
    expect(list.find((c) => c.name === "Billing")?.count).toBe(0);
    expect(list.find((c) => c.name === "Login")?.count).toBe(1);

    const login = await notifications(a.id);
    expect(login).toHaveLength(1);
    expect(login[0].sources[0]).toMatchObject({ source: "gmail", author: "Rafael" });
    expect(login[0].existingEpics).toEqual([{ key: "SCRUM-1", label: "SCRUM-1 Sign-in" }]);

    const general = await notifications(null);
    expect(general).toHaveLength(1);
    expect(general[0].places[0]).toEqual({ projectId: b.id, name: "Billing", best: true });

    expect((await decisions(a.id)).map((d) => d.text)).toEqual(['You marked "Old" as not needed.']);
  });
});
