// The owner's agenda: open promises (both directions) and the meetings ISA will join, by day.
import { and, asc, gt, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { bucketOf, dayKey, TIME_ZONE, type ReminderRow } from "@/lib/reminders";

export type AgendaMeeting = { id: string; title: string; platform: string; at: Date };

export type AgendaDay = {
  id: string;
  label: string;
  tone: "danger" | "warn" | "ink" | "muted";
  meetings: AgendaMeeting[];
  reminders: ReminderRow[];
};

const DAY = 86400000;

/** Meetings the notetaker is scheduled for or sitting in, from three hours ago onward. */
export async function upcomingMeetings(now = new Date()): Promise<AgendaMeeting[]> {
  const rows = await db
    .select({ id: schema.meetingBots.id, title: schema.meetingBots.title, platform: schema.meetingBots.platform, at: schema.meetingBots.joinAt })
    .from(schema.meetingBots)
    .where(and(inArray(schema.meetingBots.status, ["scheduled", "in_call"]), gt(schema.meetingBots.joinAt, new Date(now.getTime() - 3 * 3_600_000))))
    .orderBy(asc(schema.meetingBots.joinAt))
    .limit(20);
  return rows.flatMap((r) => (r.at ? [{ ...r, at: r.at }] : []));
}

const dayLabel = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export const meetingTime = (d: Date) => new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });

/**
 * The agenda grouped the way a day is read: what is late, today, each of the next seven days,
 * then later and undated. Days with nothing on them are left out.
 */
export function agendaDays(reminders: ReminderRow[], meetings: AgendaMeeting[] = [], now = new Date()): AgendaDay[] {
  const today = dayKey(now);
  const days: AgendaDay[] = [];
  const overdue = reminders.filter((r) => bucketOf(r, now) === "overdue");
  if (overdue.length) days.push({ id: "overdue", label: "Overdue", tone: "danger", meetings: [], reminders: overdue });

  for (let i = 0; i <= 7; i++) {
    const key = dayKey(new Date(now.getTime() + i * DAY));
    const due = reminders.filter((r) => r.due && dayKey(r.due) === key);
    const met = meetings.filter((m) => dayKey(m.at) === key);
    if (!due.length && !met.length) continue;
    const label = key === today ? `Today · ${dayLabel(key)}` : i === 1 ? `Tomorrow · ${dayLabel(key)}` : dayLabel(key);
    days.push({ id: key, label, tone: key === today ? "warn" : "ink", meetings: met, reminders: due });
  }

  const later = reminders.filter((r) => bucketOf(r, now) === "later");
  if (later.length) days.push({ id: "later", label: "Later", tone: "muted", meetings: [], reminders: later });
  const undated = reminders.filter((r) => bucketOf(r, now) === "undated");
  if (undated.length) days.push({ id: "undated", label: "No date", tone: "muted", meetings: [], reminders: undated });
  return days;
}
