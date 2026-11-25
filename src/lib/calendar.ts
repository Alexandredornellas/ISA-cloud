import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { GoogleClient } from "@/lib/google";
import { platformOf, type RecallClient } from "@/lib/recall";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const LOOK_AHEAD_MS = 24 * 3_600_000;

type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  location?: string;
  description?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: { self?: boolean; responseStatus?: string; email?: string; displayName?: string; resource?: boolean }[];
};

export type CalendarMeeting = { key: string; title: string; at: Date; platform: string | null; attendees: { name: string | null; email: string | null }[] };

/**
 * The owner's timed meetings from three hours ago to seven days ahead, with who else is invited.
 * Cancelled and declined ones are left out. Read-only: nothing is scheduled or changed.
 */
export async function calendarMeetings(google: Pick<GoogleClient, "get">, now = Date.now()): Promise<CalendarMeeting[]> {
  const list = await google.get<{ items?: CalendarEvent[] }>(API, {
    timeMin: new Date(now - 3 * 3_600_000).toISOString(),
    timeMax: new Date(now + 7 * 24 * 3_600_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "60",
  });
  return (list.items ?? []).flatMap((e) => {
    const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
    const declined = e.attendees?.some((a) => a.self && a.responseStatus === "declined");
    if (!start || e.status === "cancelled" || declined) return [];
    const link = meetingLink(e);
    return [
      {
        key: `${e.id}@${start.toISOString()}`,
        title: e.summary || "Meeting",
        at: start,
        platform: link ? platformOf(link) : null,
        attendees: (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => ({ name: a.displayName?.trim() || null, email: a.email?.toLowerCase() ?? null })),
      },
    ];
  });
}

/** The first Zoom, Meet or Teams link in a calendar event. */
export function meetingLink(e: CalendarEvent): string | null {
  const candidates = [
    e.hangoutLink,
    ...(e.conferenceData?.entryPoints ?? []).filter((p) => p.entryPointType === "video").map((p) => p.uri),
    ...`${e.location ?? ""} ${e.description ?? ""}`.match(/https:\/\/[^\s"<>)]+/g) ?? [],
  ];
  for (const c of candidates) if (c && platformOf(c)) return c;
  return null;
}

/**
 * When auto-join is on, send the meeting bot to every meeting in the next 24 hours that has a
 * video link and that the owner has not declined. Each meeting time is scheduled once.
 */
export async function scheduleCalendarBots(google: Pick<GoogleClient, "get" | "state">, recall: Pick<RecallClient, "createBot">, now = Date.now()) {
  const state = await google.state();
  if (state.autoJoin !== "on") return 0;

  const list = await google.get<{ items?: CalendarEvent[] }>(API, {
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + LOOK_AHEAD_MS).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });

  const wanted = (list.items ?? []).flatMap((e) => {
    const link = meetingLink(e);
    const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
    const declined = e.attendees?.some((a) => a.self && a.responseStatus === "declined");
    if (!link || !start || e.status === "cancelled" || declined) return [];
    return [{ key: `${e.id}@${start.toISOString()}`, link, start, title: e.summary || "Meeting" }];
  });
  if (!wanted.length) return 0;

  const existing = await db
    .select({ key: schema.meetingBots.calendarEventId })
    .from(schema.meetingBots)
    .where(inArray(schema.meetingBots.calendarEventId, wanted.map((w) => w.key)));
  const seen = new Set(existing.map((r) => r.key));

  let scheduled = 0;
  for (const w of wanted) {
    if (seen.has(w.key)) continue;
    try {
      // A start time less than a minute away joins now.
      const joinAt = w.start.getTime() - now > 60_000 ? w.start : null;
      const bot = await recall.createBot(w.link, joinAt);
      await db.insert(schema.meetingBots).values({
        recallBotId: bot.id,
        meetingUrl: w.link,
        title: w.title,
        platform: platformOf(w.link)!,
        joinAt: w.start,
        calendarEventId: w.key,
      });
      scheduled += 1;
    } catch (err) {
      console.error("calendar bot failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return scheduled;
}
