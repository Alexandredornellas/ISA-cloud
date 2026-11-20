import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeChange, recordIsaWrite, trackJira, type JiraTracker } from "@/lib/jira-track";
import type { ChangelogEntry, TicketDetail } from "@/lib/jira";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.ticketChanges);
  await db.delete(schema.jiraTickets);
  await db.delete(schema.requirements);
  await db.delete(schema.projects);
});

const detail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  key: "SCRUM-1",
  issueType: "Story",
  summary: "Login with MFA",
  description: "Users sign in with a code",
  status: "To Do",
  assignee: null,
  sprint: null,
  epic: null,
  labels: [],
  updated: new Date("2026-11-20T10:00:00Z"),
  ...over,
});

function fakeJira(state: { details: TicketDetail[]; history: ChangelogEntry[] }): JiraTracker {
  return {
    ticketDetails: async (keys) => state.details.filter((d) => keys.includes(d.key)),
    changelog: async () => state.history,
    myAccountId: async () => "isa-account",
  };
}

async function setup() {
  const [p] = await db.insert(schema.projects).values({ name: "Login" }).returning();
  await db.insert(schema.requirements).values({ projectId: p.id, title: "MFA", jiraIssueKey: "SCRUM-1" });
  return p;
}

describe("trackJira", () => {
  it("takes a snapshot first, then records who changed what", async () => {
    const p = await setup();
    const state: { details: TicketDetail[]; history: ChangelogEntry[] } = {
      details: [detail()],
      history: [{ id: "100", at: new Date("2026-11-20T09:00:00Z"), author: "Old", authorAccountId: "x", items: [{ field: "status", from: "A", to: "B" }] }],
    };
    const jira = fakeJira(state);

    const first = await trackJira(jira);
    expect(first.changes).toHaveLength(0);
    const snap = await db.query.jiraTickets.findFirst({ where: eq(schema.jiraTickets.key, "SCRUM-1") });
    expect(snap).toMatchObject({ projectId: p.id, summary: "Login with MFA", historySeenUpTo: "100" });

    state.details = [detail({ assignee: "Ana", sprint: "Sprint 4", updated: new Date("2026-11-20T11:00:00Z") })];
    state.history.push({
      id: "101",
      at: new Date("2026-11-20T11:00:00Z"),
      author: "Ana",
      authorAccountId: "ana",
      items: [
        { field: "assignee", from: null, to: "Ana" },
        { field: "Sprint", from: null, to: "Sprint 4" },
      ],
    });
    const second = await trackJira(jira);
    expect(second.changes.map((c) => describeChange(c))).toEqual([
      'Ana changed the assignee of SCRUM-1 from "(empty)" to "Ana"',
      'Ana changed the sprint of SCRUM-1 from "(empty)" to "Sprint 4"',
    ]);
    const after = await db.query.jiraTickets.findFirst({ where: eq(schema.jiraTickets.key, "SCRUM-1") });
    expect(after).toMatchObject({ assignee: "Ana", sprint: "Sprint 4", historySeenUpTo: "101" });

    // Nothing new in Jira: nothing recorded twice.
    expect((await trackJira(jira)).changes).toHaveLength(0);
    expect(await db.select().from(schema.ticketChanges)).toHaveLength(2);
  });

  it("does not report ISA's own edits as someone else's", async () => {
    await setup();
    const state = { details: [detail()], history: [] as ChangelogEntry[] };
    const jira = fakeJira(state);
    await trackJira(jira);

    await recordIsaWrite("SCRUM-1");
    state.details = [detail({ summary: "Login with MFA and SMS", updated: new Date() })];
    state.history.push({ id: "5", at: new Date(), author: "Alex", authorAccountId: "isa-account", items: [{ field: "summary", from: "Login with MFA", to: "Login with MFA and SMS" }] });
    const out = await trackJira(jira);
    expect(out.changes).toHaveLength(0);
    const [row] = await db.select().from(schema.ticketChanges);
    expect(row.byIsa).toBe("yes");
  });

  it("marks tickets deleted in Jira", async () => {
    await setup();
    const state = { details: [detail()], history: [] as ChangelogEntry[] };
    await trackJira(fakeJira(state));
    await db.update(schema.requirements).set({ jiraIssueKey: null });
    state.details = [];
    const out = await trackJira(fakeJira(state));
    expect(out.deleted).toBe(1);
    const snap = await db.query.jiraTickets.findFirst({ where: eq(schema.jiraTickets.key, "SCRUM-1") });
    expect(snap?.deletedAt).not.toBeNull();
  });
});
