import { describe, expect, it } from "vitest";
import { changeFrom, changeParts, jiraChange } from "@/lib/activity";
import { agendaDays } from "@/lib/agenda";
import { needRows, projectLine } from "@/lib/briefing";
import type { ProjectHealth } from "@/lib/portfolio";
import type { ReminderRow } from "@/lib/reminders";

const project = (over: Partial<ProjectHealth>): ProjectHealth => ({
  id: "p1", name: "Checkout", summary: "", status: "on_track", needsYou: 0, openRequirements: 0, tickets: 0, owed: 0, waitingOn: 0, risks: [], waiting: [], lastActivity: null, changesThisWeek: 0, ...over,
});
const risk = (kind: ProjectHealth["risks"][number]["kind"], text: string) => ({ kind, text, projectId: "p1", projectName: "Checkout" });

describe("needs you rows", () => {
  it("puts conflicts first and shows a waiting draft once, as the draft", () => {
    const rows = needRows(
      [
        project({
          risks: [risk("waiting", "Draft has waited 3 days"), risk("overdue", "Rafael is late"), risk("drift", "CHK-12 edited")],
          waiting: [{ id: "d1", title: "Add Pix", failed: false, steps: 3 }],
        }),
      ],
      1,
    );
    expect(rows.map((r) => r.chip)).toEqual(["Conflict", "Overdue", "Approve", "File"]);
    expect(rows[2].text).toBe("Add Pix · 3 steps drafted");
  });

  it("has nothing to show for a quiet portfolio", () => {
    expect(needRows([project({})])).toEqual([]);
    expect(projectLine(project({}))).toBe("On track");
  });
});

describe("before → after", () => {
  const v = (version: number, over: object) => ({ requirementId: "r1", version, title: "Guest checkout", description: "", status: "approved" as const, eventIds: [] as string[], ...over });

  it("reads a retitle as old title → new title, keeping the shared words", () => {
    const change = changeFrom("e2", [v(1, { title: "Guest checkout without an account" }), v(2, { title: "Guest checkout with cards and Pix", eventIds: ["e2"] })]);
    expect(change).toEqual({ subject: null, from: "Guest checkout without an account", to: "Guest checkout with cards and Pix" });
    expect(changeParts(change!)[0]).toEqual({ kind: "same", text: "Guest checkout " });
  });

  it("reads a reworded description as the words that went and came", () => {
    const change = changeFrom("e2", [v(1, { description: "Pay by card." }), v(2, { description: "Pay by card or Pix.", eventIds: ["e2"], status: "changed" })]);
    expect(change).toEqual({ subject: "Guest checkout", from: "", to: "or Pix." });
    expect(changeParts(change!)).toEqual([{ kind: "added", text: "or Pix." }]);
    const reworded = changeFrom("e2", [v(1, { description: "Cards in the provider vault" }), v(2, { description: "Cards in our own database", eventIds: ["e2"] })]);
    expect(reworded).toEqual({ subject: "Guest checkout", from: "the provider vault", to: "our own database" });
  });

  it("says nothing for the first version or an unrelated item", () => {
    expect(changeFrom("e1", [v(1, { eventIds: ["e1"] })])).toBeNull();
    expect(changeFrom("other", [v(1, {}), v(2, { title: "New", eventIds: ["e2"] })])).toBeNull();
  });

  it("shows short Jira fields and leaves long ones to the detail view", () => {
    expect(jiraChange({ field: "status", fromValue: "To do", toValue: "In progress" })).toEqual({ subject: "status", from: "To do", to: "In progress" });
    expect(jiraChange({ field: "description", fromValue: "a", toValue: "b" })).toBeNull();
  });
});

describe("agenda by day", () => {
  const now = new Date("2026-11-24T15:00:00Z");
  const r = (id: string, due: string | null): ReminderRow => ({ id, due: due ? new Date(`${due}T12:00:00Z`) : null }) as ReminderRow;

  it("groups late, today, each coming day, later and undated, with meetings on their day", () => {
    const days = agendaDays(
      [r("late", "2026-11-22"), r("today", "2026-11-24"), r("thu", "2026-11-26"), r("far", "2026-12-20"), r("none", null)],
      [{ id: "m1", title: "Partner sync", platform: "meet", at: new Date("2026-11-25T14:00:00Z") }],
      now,
    );
    expect(days.map((d) => d.id)).toEqual(["overdue", "2026-11-24", "2026-11-25", "2026-11-26", "later", "undated"]);
    expect(days[1].label).toBe("Today · Tue, Nov 24");
    expect(days[2].meetings).toHaveLength(1);
    expect(days[2].reminders).toHaveLength(0);
  });
});
