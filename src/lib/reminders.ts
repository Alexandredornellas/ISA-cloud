// The owner's reminders: what they promised to send or do, for whom and by when. ISA picks them
// up from meetings, email and Slack, or the owner adds them. They never contact anyone.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Commitment } from "@/lib/plan";

export type Reminder = typeof schema.reminders.$inferSelect;

/** The owner's time zone, for "today" and "overdue". */
export const TIME_ZONE = process.env.ISA_TIMEZONE || "America/Fortaleza";

/** A day as YYYY-MM-DD in the owner's time zone. */
export function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** A YYYY-MM-DD deadline, stored at midday UTC so it shows as the same day everywhere nearby. */
export function dueFrom(day: string | null | undefined): Date | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Save what an item asks of the owner. An item read twice does not add the same reminder twice. */
export async function saveCommitments(eventId: string, commitments: Commitment[], projectIds: Set<string>): Promise<number> {
  const clean = commitments.filter((c) => c.what.trim());
  if (!clean.length) return 0;
  const existing = await db.select({ text: schema.reminders.text }).from(schema.reminders).where(eq(schema.reminders.eventId, eventId));
  const seen = new Set(existing.map((r) => r.text.toLowerCase()));
  const rows = clean
    .filter((c) => !seen.has(c.what.trim().toLowerCase()))
    .map((c) => ({
      eventId,
      projectId: c.projectId && projectIds.has(c.projectId) ? c.projectId : null,
      text: c.what.trim().slice(0, 300),
      direction: c.owedBy?.trim() ? "theirs" : "mine",
      person: c.owedBy?.trim() || c.forWhom?.trim() || null,
      due: dueFrom(c.due),
      dueText: c.dueText?.trim() || null,
      quote: c.quote.trim().slice(0, 500) || null,
    }));
  if (rows.length) await db.insert(schema.reminders).values(rows);
  return rows.length;
}

export async function addReminder(input: { text: string; person?: string | null; due?: string | null; projectId?: string | null; direction?: "mine" | "theirs" }) {
  const text = input.text.trim();
  if (!text) throw new Error("Say what to do");
  const [row] = await db
    .insert(schema.reminders)
    .values({ text: text.slice(0, 300), direction: input.direction === "theirs" && input.person?.trim() ? "theirs" : "mine", person: input.person?.trim() || null, due: dueFrom(input.due), projectId: input.projectId || null })
    .returning();
  return row;
}

export async function setReminderStatus(id: string, status: "open" | "done" | "dismissed") {
  await db
    .update(schema.reminders)
    .set({ status, doneAt: status === "open" ? null : new Date(), updatedAt: new Date() })
    .where(eq(schema.reminders.id, id));
}

export type ReminderRow = Reminder & { projectName: string | null; source: { source: string; title: string; url: string | null; at: Date } | null };

/** Whether the owner set this aside until a day that has not come yet. */
export function isSnoozed(r: Pick<Reminder, "snoozedUntil">, now = new Date()): boolean {
  return !!r.snoozedUntil && dayKey(r.snoozedUntil) > dayKey(now);
}

/**
 * Open reminders (a project's, or all), soonest deadline first, undated last. Snoozed ones are
 * left out until their day comes; pass "only" to get just those.
 */
export async function openReminders(projectId?: string | null, snoozed: "hide" | "only" = "hide", now = new Date()): Promise<ReminderRow[]> {
  const rows = await db
    .select()
    .from(schema.reminders)
    .where(and(eq(schema.reminders.status, "open"), projectId ? eq(schema.reminders.projectId, projectId) : undefined))
    .orderBy(sql`${schema.reminders.due} asc nulls last`, asc(schema.reminders.createdAt));
  return withContext(rows.filter((r) => isSnoozed(r, now) === (snoozed === "only")));
}

/** Set a reminder aside for some days (it comes back on that day), or wake it with null. */
export async function snoozeReminder(id: string, days: number | null, now = new Date()) {
  const until = days ? dueFrom(dayKey(new Date(now.getTime() + days * 86400000))) : null;
  await db.update(schema.reminders).set({ snoozedUntil: until, updatedAt: new Date() }).where(eq(schema.reminders.id, id));
}

/** Done in the last week, for "what did I already send?". */
export async function recentlyDone(): Promise<ReminderRow[]> {
  const rows = await db
    .select()
    .from(schema.reminders)
    .where(and(eq(schema.reminders.status, "done"), sql`${schema.reminders.doneAt} > now() - interval '7 days'`))
    .orderBy(sql`${schema.reminders.doneAt} desc`)
    .limit(20);
  return withContext(rows);
}

async function withContext(rows: Reminder[]): Promise<ReminderRow[]> {
  const projectIds = [...new Set(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])))];
  const eventIds = [...new Set(rows.flatMap((r) => (r.eventId ? [r.eventId] : [])))];
  const [projects, events] = await Promise.all([
    projectIds.length ? db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, projectIds)) : [],
    eventIds.length
      ? db
          .select({ id: schema.events.id, source: schema.events.source, title: schema.events.title, url: schema.events.url, at: schema.events.occurredAt })
          .from(schema.events)
          .where(inArray(schema.events.id, eventIds))
      : [],
  ]);
  return rows.map((r) => ({
    ...r,
    projectName: projects.find((p) => p.id === r.projectId)?.name ?? null,
    source: events.find((e) => e.id === r.eventId) ?? null,
  }));
}

export type Bucket = "overdue" | "today" | "week" | "later" | "undated";

export function bucketOf(r: Pick<Reminder, "due">, now = new Date()): Bucket {
  if (!r.due) return "undated";
  const due = dayKey(r.due);
  const today = dayKey(now);
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= dayKey(new Date(now.getTime() + 7 * 86400000)) ? "week" : "later";
}

/** How many of the owner's open reminders are overdue or due today: the number the sidebar shows. */
export async function dueCount(now = new Date()): Promise<number> {
  const rows = await db
    .select({ due: schema.reminders.due, snoozedUntil: schema.reminders.snoozedUntil })
    .from(schema.reminders)
    .where(and(eq(schema.reminders.status, "open"), eq(schema.reminders.direction, "mine")));
  return rows.filter((r) => !isSnoozed(r, now) && ["overdue", "today"].includes(bucketOf(r, now))).length;
}

/** Plain text of open reminders, for Claude in the chat. */
export function remindersText(rows: ReminderRow[], now = new Date()): string {
  if (!rows.length) return "No open reminders.";
  return rows
    .map(
      (r) =>
        `- [${r.id}] ${r.direction === "theirs" ? `WAITING ON ${r.person ?? "someone"}: ` : ""}${r.text}${r.person && r.direction === "mine" ? ` (for ${r.person})` : ""}${r.due ? ` due ${dayKey(r.due)}${bucketOf(r, now) === "overdue" ? " OVERDUE" : ""}` : " no date"}${r.projectName ? ` · project ${r.projectName}` : ""}${r.source ? ` · from ${r.source.title}` : ""}`,
    )
    .join("\n");
}

