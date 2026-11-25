// The brief before a meeting: what the owner owes the people in it, what they owe the owner, what
// is unsettled in their projects and what changed there lately. Built from ISA's stored facts by
// plain rules, so it is instant and exact. Nothing here contacts anyone.
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { activity } from "@/lib/activity";
import type { AgendaMeeting, Attendee } from "@/lib/agenda";
import { changeRows, type ChangeRow } from "@/lib/briefing";
import { portfolio, type ProjectHealth } from "@/lib/portfolio";
import type { ReminderRow } from "@/lib/reminders";
import { getSettings } from "@/lib/settings";

export type Brief = {
  /** Who is in the meeting, by name, as far as ISA can tell. */
  people: string[];
  projects: { id: string; name: string }[];
  youOwe: ReminderRow[];
  theyOwe: ReminderRow[];
  /** Conflicts with Jira and drafts waiting, in the meeting's projects. */
  toSettle: { text: string; projectName: string }[];
  changed: ChangeRow[];
  /** How many things the brief holds, for the row's badge. */
  points: number;
};

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Whether a reminder's person is one of these people: same full name, or same first name when only one is known. */
export function samePerson(person: string | null, names: string[]): boolean {
  if (!person) return false;
  const p = norm(person);
  return names.some((n) => {
    const m = norm(n);
    if (!m) return false;
    if (p === m) return true;
    const [pf, mf] = [p.split(/\s+/)[0], m.split(/\s+/)[0]];
    return pf === mf && (p === pf || m === mf);
  });
}

export type BriefFacts = {
  reminders: ReminderRow[];
  projects: ProjectHealth[];
  changes: ChangeRow[];
  /** People ISA knows, to turn an invitee's email into a name. */
  directory: { name: string; email: string | null; projectIds: string[] }[];
  /** Earlier items with a title, the projects they were filed under and who took part. */
  history: { title: string; projectIds: string[]; people: string[] }[];
};

/**
 * Work out a meeting's brief. Its people are the invitees plus whoever took part in earlier
 * meetings of the same name. Its projects are the ones those earlier meetings were filed under,
 * the ones named in its title, and the ones its people are stakeholders of or owe things in.
 */
export function briefFor(meeting: Pick<AgendaMeeting, "title" | "attendees">, facts: BriefFacts, changeLimit = 3): Brief {
  const title = norm(meeting.title);
  const past = facts.history.filter((h) => norm(h.title) === title);
  const known = (a: Attendee) => facts.directory.find((d) => (a.email && d.email?.toLowerCase() === a.email) || (a.name && norm(d.name) === norm(a.name)));
  const people = [...new Set([...meeting.attendees.map((a) => known(a)?.name ?? a.name ?? a.email?.split("@")[0] ?? "").filter(Boolean), ...past.flatMap((h) => h.people)])];

  const youOwe = facts.reminders.filter((r) => r.direction === "mine" && samePerson(r.person, people));
  const theyOwe = facts.reminders.filter((r) => r.direction === "theirs" && samePerson(r.person, people));

  const projectIds = new Set<string>([
    ...past.flatMap((h) => h.projectIds),
    ...facts.projects.filter((p) => title.includes(norm(p.name))).map((p) => p.id),
    ...[...youOwe, ...theyOwe].flatMap((r) => (r.projectId ? [r.projectId] : [])),
    ...meeting.attendees.flatMap((a) => known(a)?.projectIds ?? []),
  ]);
  const projects = facts.projects.filter((p) => projectIds.has(p.id));

  const toSettle = projects.flatMap((p) => [
    ...p.risks.filter((r) => r.kind === "drift").map((r) => ({ text: r.text, projectName: p.name })),
    ...p.waiting.map((w) => ({ text: w.failed ? `A step failed in "${w.title}".` : `Your draft "${w.title}" is not approved yet.`, projectName: p.name })),
  ]);
  const changed = facts.changes.filter((c) => projects.some((p) => c.href === `/?c=${p.id}`)).slice(0, changeLimit);

  return { people, projects: projects.map((p) => ({ id: p.id, name: p.name })), youOwe, theyOwe, toSettle, changed, points: youOwe.length + theyOwe.length + toSettle.length + changed.length };
}

/** Briefs for these meetings, by meeting id. One round of reads serves them all. */
export async function meetingBriefs(meetings: AgendaMeeting[], loaded?: { projects: ProjectHealth[]; reminders: ReminderRow[] }): Promise<Record<string, Brief>> {
  if (!meetings.length) return {};
  const [{ projects, reminders }, feed, people, duties, links, events] = await Promise.all([
    loaded ?? portfolio(),
    activity(null, 40),
    db.select({ id: schema.people.id, name: schema.people.name, email: schema.people.email }).from(schema.people),
    db.select({ personId: schema.personDuties.personId, projectId: schema.personDuties.projectId }).from(schema.personDuties),
    db.select({ eventId: schema.eventProjects.eventId, projectId: schema.eventProjects.projectId }).from(schema.eventProjects),
    db
      .select({ id: schema.events.id, title: schema.events.title, participants: schema.events.participants, author: schema.events.author })
      .from(schema.events)
      .where(inArray(schema.events.source, ["zoom", "meet", "teams"]))
      .orderBy(desc(schema.events.occurredAt))
      .limit(200),
  ]);
  const me = norm((await getSettings()).ownerName);
  const owner = (await db.query.connections.findFirst({ where: eq(schema.connections.provider, "google") }))?.account?.toLowerCase() ?? null;
  const facts: BriefFacts = {
    reminders,
    projects,
    changes: changeRows(feed),
    directory: people.filter((p) => !owner || p.email?.toLowerCase() !== owner).map((p) => ({ name: p.name, email: p.email, projectIds: duties.flatMap((d) => (d.personId === p.id && d.projectId ? [d.projectId] : [])) })),
    history: events.map((e) => ({
      title: e.title,
      projectIds: links.filter((l) => l.eventId === e.id).map((l) => l.projectId),
      people: [...new Set([...e.participants.map((p) => p.name), e.author?.replace(/\s*<.*>$/, "") ?? ""].filter((n) => n && norm(n) !== me))],
    })),
  };
  return Object.fromEntries(meetings.map((m) => [m.id, briefFor(m, facts)]));
}
