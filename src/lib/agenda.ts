// The owner's agenda: open promises (both directions) and the meetings ISA will join, by day.
import { and, asc, gt, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { calendarMeetings, type CalendarMeeting } from "@/lib/calendar";
import { GoogleClient, googleConfigFromEnv } from "@/lib/google";
import { bucketOf, dayKey, TIME_ZONE, type ReminderRow } from "@/lib/reminders";

export type Attendee = { name: string | null; email: string | null };

export type AgendaMeeting = {
  id: string;
  title: string;
  /** zoom, meet or teams when the meeting has a video link ISA knows. */
  platform: string | null;
  at: Date;
  attendees: Attendee[];
  /** Whether ISA Notetaker is scheduled for it, or already in the call. */
  notetaker: boolean;
};

export type AgendaDay = {
  id: string;
  label: string;
  tone: "danger" | "warn" | "ink" | "muted";
  meetings: AgendaMeeting[];
  reminders: ReminderRow[];
};

const DAY = 86400000;
const CALENDAR_WAIT_MS = 2_000;
const CALENDAR_KEEP_MS = 60_000;
let calendarCache: { at: number; rows: CalendarMeeting[] } | null = null;

/** The calendar's meetings, kept for a minute. A slow or failing calendar gives none, never an error page. */
async function fromCalendar(now: Date): Promise<CalendarMeeting[]> {
  if (calendarCache && now.getTime() - calendarCache.at < CALENDAR_KEEP_MS) return calendarCache.rows;
  try {
    if (!(await GoogleClient.connection())) return [];
    const google = new GoogleClient(googleConfigFromEnv());
    const rows = await Promise.race([
      calendarMeetings(google, now.getTime()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CALENDAR_WAIT_MS)),
    ]);
    calendarCache = { at: now.getTime(), rows };
    return rows;
  } catch (err) {
    console.error("agenda calendar failed", { error: err instanceof Error ? err.name : "unknown" });
    return calendarCache?.rows ?? [];
  }
}

type BotRow = { id: string; title: string; platform: string; at: Date | null; calendarEventId: string | null };

/** Calendar meetings and notetaker bookings as one list, a meeting with both shown once, soonest first. */
export function mergeMeetings(calendar: CalendarMeeting[], bots: BotRow[]): AgendaMeeting[] {
  const booked = new Set(bots.flatMap((b) => (b.calendarEventId ? [b.calendarEventId] : [])));
  return [
    ...calendar.map((c) => ({ id: c.key, title: c.title, platform: c.platform, at: c.at, attendees: c.attendees, notetaker: booked.has(c.key) })),
    ...bots.flatMap((b) => (b.at && !(b.calendarEventId && calendar.some((c) => c.key === b.calendarEventId)) ? [{ id: b.id, title: b.title, platform: b.platform, at: b.at, attendees: [], notetaker: true }] : [])),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The owner's meetings from three hours ago to a week ahead: the calendar's, plus any the notetaker was sent to by hand. */
export async function upcomingMeetings(now = new Date()): Promise<AgendaMeeting[]> {
  const [calendar, bots] = await Promise.all([
    fromCalendar(now),
    db
      .select({ id: schema.meetingBots.id, title: schema.meetingBots.title, platform: schema.meetingBots.platform, at: schema.meetingBots.joinAt, calendarEventId: schema.meetingBots.calendarEventId })
      .from(schema.meetingBots)
      .where(and(inArray(schema.meetingBots.status, ["scheduled", "in_call"]), gt(schema.meetingBots.joinAt, new Date(now.getTime() - 3 * 3_600_000))))
      .orderBy(asc(schema.meetingBots.joinAt))
      .limit(20),
  ]);
  return mergeMeetings(calendar, bots);
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

/** The next meeting on the agenda, counting one that started less than half an hour ago, and when it is in words. */
export function nextMeeting(meetings: AgendaMeeting[], now = new Date()): { meeting: AgendaMeeting; when: string } | null {
  const meeting = meetings.find((m) => m.at.getTime() > now.getTime() - 30 * 60_000);
  if (!meeting) return null;
  const day = dayKey(meeting.at) === dayKey(now) ? "today" : meeting.at.toLocaleDateString("en-US", { weekday: "short", timeZone: TIME_ZONE });
  return { meeting, when: `${day} at ${meetingTime(meeting.at)}` };
}
