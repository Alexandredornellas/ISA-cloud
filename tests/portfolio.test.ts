import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { portfolio, portfolioText } from "@/lib/portfolio";
import { addReminder } from "@/lib/reminders";
import type { Plan } from "@/lib/plan";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.reminders);
  await db.delete(schema.ticketChanges);
  await db.delete(schema.jiraTickets);
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
});

const empty: Plan = { summary: "s", projectName: null, people: [], requirementChanges: [], actions: [], openQuestions: [] };

describe("portfolio", () => {
  it("flags where Jira drifted from what was agreed, and sorts risky projects first", async () => {
    const now = new Date("2026-11-20T18:00:00Z");
    const [calm, risky] = await db.insert(schema.projects).values([{ name: "Calm" }, { name: "Risky" }]).returning();
    await db.insert(schema.requirements).values([
      { projectId: risky.id, title: "Profile MFA switch", status: "changed", jiraIssueKey: "SCRUM-10" },
      { projectId: risky.id, title: "SMS codes", status: "dropped", jiraIssueKey: "SCRUM-11", jiraStatus: "Em andamento" },
      { projectId: risky.id, title: "QR setup", status: "approved", jiraIssueKey: "SCRUM-9", jiraStatus: "Concluído" },
      { projectId: calm.id, title: "Export CSV", status: "approved", jiraIssueKey: "SCRUM-20", jiraStatus: "A fazer" },
    ]);
    await db.insert(schema.ticketChanges).values({
      key: "SCRUM-9", projectId: risky.id, historyId: "h1", field: "description", author: "Ana", changedAt: new Date(now.getTime() - 3600000), byIsa: "no",
    });
    await db.insert(schema.proposals).values({ kind: "update", projectId: calm.id, title: "Old draft", plan: empty, eventIds: [], createdAt: new Date(now.getTime() - 3 * 86400000) });
    await addReminder({ text: "Confirm the schema", person: "Weslei", direction: "theirs", due: "2026-11-18", projectId: risky.id });

    const { projects, reminders } = await portfolio(now);
    expect(projects.map((p) => [p.name, p.status])).toEqual([
      ["Risky", "at_risk"],
      ["Calm", "attention"],
    ]);
    const texts = projects[0].risks.map((r) => `${r.kind}: ${r.text}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("drift: \"Profile MFA switch\" changed in a conversation, but SCRUM-10"),
        expect.stringContaining("drift: \"SMS codes\" was dropped, but SCRUM-11 is still open"),
        expect.stringContaining("drift: Jira says SCRUM-9 is done"),
        expect.stringContaining("drift: Ana edited the description of SCRUM-9"),
        expect.stringContaining("overdue: Weslei is late on: Confirm the schema"),
      ]),
    );
    expect(projects[1].risks[0]).toMatchObject({ kind: "waiting" });
    expect(projects[0].waitingOn).toBe(1);
    expect(portfolioText(projects, reminders, now)).toContain("Waiting on Weslei: Confirm the schema (due 2026-11-18, OVERDUE)");
  });
});

describe("status reports", () => {
  it("writes from the portfolio for the chosen audience", async () => {
    const { draftReport } = await import("@/lib/brain/report");
    const [p] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    await addReminder({ text: "Send the contract", person: "Rafael", direction: "theirs", projectId: p.id });
    let seen = { context: "", input: "" };
    const report = await draftReport(
      async (req) => {
        seen = req;
        return { subject: "Weekly status", body: "All good" } as never;
      },
      "executive",
      null,
    );
    expect(report.subject).toBe("Weekly status");
    expect(seen.context).toContain("## Checkout");
    expect(seen.context).toContain("Waiting on Rafael: Send the contract");
    expect(seen.input).toContain("Audience: Executives");
  });
});
