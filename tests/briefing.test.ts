import { describe, expect, it } from "vitest";
import { changeFrom, changeParts, jiraChange } from "@/lib/activity";
import { agendaDays, mergeMeetings } from "@/lib/agenda";
import { briefFor, type BriefFacts } from "@/lib/brief";
import { needRows, projectLine } from "@/lib/briefing";
import type { ProjectHealth } from "@/lib/portfolio";
import { isSnoozed, type ReminderRow } from "@/lib/reminders";

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
      [{ id: "m1", title: "Partner sync", platform: "meet", at: new Date("2026-11-25T14:00:00Z"), attendees: [], notetaker: true }],
      now,
    );
    expect(days.map((d) => d.id)).toEqual(["overdue", "2026-11-24", "2026-11-25", "2026-11-26", "later", "undated"]);
    expect(days[1].label).toBe("Today · Tue, Nov 24");
    expect(days[2].meetings).toHaveLength(1);
    expect(days[2].reminders).toHaveLength(0);
  });
});

describe("meeting brief", () => {
  const rem = (id: string, direction: "mine" | "theirs", person: string, projectId = "p1") => ({ id, direction, person, projectId, text: id, due: null }) as ReminderRow;
  const facts: BriefFacts = {
    reminders: [rem("scope", "mine", "Rafael Costa"), rem("contract", "theirs", "Rafael"), rem("changelog", "mine", "Priya Nair", "p2")],
    projects: [
      project({ risks: [risk("drift", "CHK-12 edited"), risk("overdue", "late")], waiting: [{ id: "d1", title: "Add Pix", failed: false, steps: 3 }] }),
      project({ id: "p2", name: "Partner API" }),
    ],
    changes: [{ key: "c1", href: "/?c=p1" }, { key: "c2", href: "/?c=p2" }] as BriefFacts["changes"],
    directory: [{ name: "Priya Nair", email: "priya@globex.example", projectIds: ["p2"] }],
    history: [{ title: "Loja Viva weekly", projectIds: ["p1"], people: ["Rafael Costa", "João Lima"] }],
  };

  it("knows a recurring meeting by its earlier sessions: who comes, which project, what is owed", () => {
    const b = briefFor({ title: "Loja Viva Weekly", attendees: [] }, facts);
    expect(b.people).toEqual(["Rafael Costa", "João Lima"]);
    expect(b.projects).toEqual([{ id: "p1", name: "Checkout" }]);
    expect(b.youOwe.map((r) => r.id)).toEqual(["scope"]);
    expect(b.theyOwe.map((r) => r.id)).toEqual(["contract"]);
    expect(b.toSettle.map((t) => t.text)).toEqual(["CHK-12 edited", 'Your draft "Add Pix" is not approved yet.']);
    expect(b.changed.map((c) => c.key)).toEqual(["c1"]);
    expect(b.points).toBe(5);
  });

  it("names an invitee from the directory by email and brings their project", () => {
    const b = briefFor({ title: "Intro call", attendees: [{ name: null, email: "priya@globex.example" }] }, facts);
    expect(b.people).toEqual(["Priya Nair"]);
    expect(b.youOwe.map((r) => r.id)).toEqual(["changelog"]);
    expect(b.projects.map((p) => p.id)).toEqual(["p2"]);
  });

  it("is empty for a meeting ISA knows nothing about", () => {
    expect(briefFor({ title: "Dentist", attendees: [] }, facts).points).toBe(0);
  });
});

describe("meetings from the calendar and the notetaker", () => {
  it("shows a calendar meeting once, marked when the notetaker is booked, and keeps hand-sent bots", () => {
    const at = new Date("2026-11-25T14:00:00Z");
    const merged = mergeMeetings(
      [{ key: "ev1@x", title: "Sync", at, platform: "meet", attendees: [] }, { key: "ev2@x", title: "Lunch", at: new Date("2026-11-25T16:00:00Z"), platform: null, attendees: [] }],
      [{ id: "b1", title: "Sync", platform: "meet", at, calendarEventId: "ev1@x" }, { id: "b2", title: "Ad hoc", platform: "zoom", at: new Date("2026-11-25T15:00:00Z"), calendarEventId: null }],
    );
    expect(merged.map((m) => [m.title, m.notetaker])).toEqual([["Sync", true], ["Ad hoc", true], ["Lunch", false]]);
  });
});

describe("snooze", () => {
  it("hides a reminder until its day comes", () => {
    const now = new Date("2026-11-24T15:00:00Z");
    expect(isSnoozed({ snoozedUntil: new Date("2026-11-25T12:00:00Z") }, now)).toBe(true);
    expect(isSnoozed({ snoozedUntil: new Date("2026-11-24T12:00:00Z") }, now)).toBe(false);
    expect(isSnoozed({ snoozedUntil: null }, now)).toBe(false);
  });
});
