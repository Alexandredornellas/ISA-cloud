// The owner's portfolio: every project's health at a glance, for a BA, PM or TPM who holds
// several projects. Risks come from plain rules over ISA's records, so they are cheap and exact.
import { desc, gt, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { bucketOf, openReminders, type ReminderRow } from "@/lib/reminders";

export type RiskKind = "drift" | "overdue" | "failed" | "waiting" | "no_ticket";

export type Risk = { kind: RiskKind; text: string; projectId: string; projectName: string };

export type ProjectHealth = {
  id: string;
  name: string;
  summary: string;
  status: "on_track" | "attention" | "at_risk";
  needsYou: number;
  openRequirements: number;
  tickets: number;
  owed: number;
  waitingOn: number;
  risks: Risk[];
  lastActivity: { title: string; source: string; at: Date } | null;
  changesThisWeek: number;
};

const JIRA_DONE = /^(done|closed|resolved|conclu[ií]d[oa]|fechad[oa]|resolvid[oa]|feito)$/i;
const DAY = 86400000;

export async function portfolio(now = new Date()): Promise<{ projects: ProjectHealth[]; reminders: ReminderRow[] }> {
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [projects, reqs, tickets, proposals, changes, links, reminders] = await Promise.all([
    db.select().from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
    db.select().from(schema.requirements),
    db.select().from(schema.jiraTickets),
    db.select().from(schema.proposals).where(inArray(schema.proposals.status, ["pending", "failed", "approved"])),
    db.select().from(schema.ticketChanges).where(gt(schema.ticketChanges.changedAt, new Date(now.getTime() - 3 * DAY))),
    db.select({ eventId: schema.eventProjects.eventId, projectId: schema.eventProjects.projectId }).from(schema.eventProjects),
    openReminders(),
  ]);
  const eventIds = [...new Set(links.map((l) => l.eventId))];
  const events = eventIds.length
    ? await db
        .select({ id: schema.events.id, title: schema.events.title, source: schema.events.source, at: schema.events.occurredAt })
        .from(schema.events)
        .where(inArray(schema.events.id, eventIds))
        .orderBy(desc(schema.events.occurredAt))
    : [];
  const ticketByKey = new Map(tickets.map((t) => [t.key, t]));

  const health = projects.map((p): ProjectHealth => {
    const risks: Risk[] = [];
    const add = (kind: RiskKind, text: string) => risks.push({ kind, text, projectId: p.id, projectName: p.name });
    const mine = reqs.filter((r) => r.projectId === p.id);
    const props = proposals.filter((x) => x.projectId === p.id && x.kind !== "clarify");
    const pending = props.filter((x) => x.status === "pending");

    // Drift: what was agreed in conversations and what Jira says no longer match.
    for (const r of mine) {
      const t = r.jiraIssueKey ? ticketByKey.get(r.jiraIssueKey) : undefined;
      const jiraStatus = t?.status ?? r.jiraStatus ?? "";
      if (r.status === "changed" && r.jiraIssueKey && pending.length === 0) {
        add("drift", `"${r.title}" changed in a conversation, but ${r.jiraIssueKey} in Jira still has the old version.`);
      }
      if (r.status === "dropped" && r.jiraIssueKey && jiraStatus && !JIRA_DONE.test(jiraStatus)) {
        add("drift", `"${r.title}" was dropped, but ${r.jiraIssueKey} is still open in Jira (${jiraStatus}).`);
      }
      if (r.status !== "done" && r.status !== "dropped" && r.jiraIssueKey && JIRA_DONE.test(jiraStatus)) {
        add("drift", `Jira says ${r.jiraIssueKey} is done, but "${r.title}" is still open here. Check whether it was really delivered.`);
      }
      if (r.status === "approved" && !r.jiraIssueKey && now.getTime() - r.updatedAt.getTime() > DAY) {
        add("no_ticket", `"${r.title}" was approved ${Math.floor((now.getTime() - r.updatedAt.getTime()) / DAY)} day(s) ago and still has no Jira ticket.`);
      }
    }
    const edited = new Map<string, (typeof changes)[number]>();
    for (const c of changes) {
      if (c.projectId === p.id && c.byIsa === "no" && /summary|description|resumo|descri/i.test(c.field)) edited.set(c.key, c);
    }
    for (const c of edited.values()) {
      add("drift", `${c.author ?? "Someone"} edited the ${/summary|resumo/i.test(c.field) ? "title" : "description"} of ${c.key} in Jira. Check it still matches what was agreed.`);
    }

    for (const x of props.filter((x) => x.status === "failed")) add("failed", `"${x.title}" was approved, but a step failed.`);
    for (const x of pending) {
      const days = Math.floor((now.getTime() - x.createdAt.getTime()) / DAY);
      if (days >= 2) add("waiting", `"${x.title}" has been waiting for your review for ${days} days.`);
    }
    const rem = reminders.filter((r) => r.projectId === p.id);
    for (const r of rem.filter((r) => bucketOf(r, now) === "overdue")) {
      add("overdue", r.direction === "theirs" ? `${r.person ?? "Someone"} is late on: ${r.text}.` : `You are late on: ${r.text}${r.person ? ` (for ${r.person})` : ""}.`);
    }

    const projEvents = events.filter((e) => links.some((l) => l.eventId === e.id && l.projectId === p.id));
    const last = projEvents[0];
    const severe = risks.some((r) => r.kind === "drift" || r.kind === "overdue" || r.kind === "failed");
    const needsYou = pending.length + props.filter((x) => x.status === "failed").length;
    return {
      id: p.id,
      name: p.name,
      summary: p.summary,
      status: severe ? "at_risk" : needsYou || risks.length || rem.some((r) => bucketOf(r, now) === "today") ? "attention" : "on_track",
      needsYou,
      openRequirements: mine.filter((r) => r.status !== "done" && r.status !== "dropped").length,
      tickets: mine.filter((r) => r.jiraIssueKey).length,
      owed: rem.filter((r) => r.direction === "mine").length,
      waitingOn: rem.filter((r) => r.direction === "theirs").length,
      risks,
      lastActivity: last ? { title: last.title, source: last.source, at: last.at } : null,
      changesThisWeek: projEvents.filter((e) => e.at > weekAgo).length + changes.filter((c) => c.projectId === p.id && c.byIsa === "no").length,
    };
  });

  const order = { at_risk: 0, attention: 1, on_track: 2 } as const;
  health.sort((a, b) => order[a.status] - order[b.status] || b.needsYou - a.needsYou);
  return { projects: health, reminders };
}

/** The portfolio in plain text, for Claude: status reports and "how are my projects?" in the chat. */
export function portfolioText(projects: ProjectHealth[], reminders: ReminderRow[], now = new Date()): string {
  const label = { at_risk: "AT RISK", attention: "NEEDS ATTENTION", on_track: "ON TRACK" } as const;
  const lines = projects.map((p) =>
    [
      `## ${p.name} [${label[p.status]}]`,
      p.summary ? p.summary : null,
      `${p.openRequirements} open requirement(s), ${p.tickets} Jira ticket(s), ${p.needsYou} suggestion(s) waiting for the owner, ${p.changesThisWeek} change(s) this week.`,
      p.lastActivity ? `Last activity: ${p.lastActivity.title} (${p.lastActivity.source}, ${p.lastActivity.at.toISOString().slice(0, 10)}).` : null,
      ...p.risks.map((r) => `- Risk (${r.kind}): ${r.text}`),
      ...reminders
        .filter((r) => r.projectId === p.id)
        .map((r) => `- ${r.direction === "theirs" ? `Waiting on ${r.person ?? "someone"}` : `Owner owes${r.person ? ` ${r.person}` : ""}`}: ${r.text}${r.due ? ` (due ${r.due.toISOString().slice(0, 10)}${bucketOf(r, now) === "overdue" ? ", OVERDUE" : ""})` : ""}`),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return lines.join("\n\n") || "No projects yet.";
}

export async function projectHealth(projectId: string): Promise<ProjectHealth | null> {
  const { projects } = await portfolio();
  return projects.find((p) => p.id === projectId) ?? null;
}

