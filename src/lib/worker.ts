import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { processEvent } from "@/lib/brain/pipeline";
import type { StructuredLLM } from "@/lib/brain/llm";
import { formatTranscript, type RecallClient } from "@/lib/recall";
import type { SlackClient } from "@/lib/slack";
import { pollSlack } from "@/lib/slack-poll";
import { GoogleClient } from "@/lib/google";
import { pollGmail } from "@/lib/gmail";
import { scheduleCalendarBots } from "@/lib/calendar";
import { syncJira, type JiraReader } from "@/lib/jira-sync";
import { trackJira, type JiraTracker } from "@/lib/jira-track";
import { reviewJiraChanges } from "@/lib/jira-review";
import { log } from "@/lib/log";

export type WorkerDeps = {
  recall: RecallClient | null;
  slack: SlackClient | null;
  google: GoogleClient | null;
  llm: StructuredLLM | null;
  jira?: (JiraReader & JiraTracker) | null;
  /** Pass number. Slack and Gmail are read every 3rd pass and the calendar every 12th, to stay inside rate limits. Omit to run everything. */
  pass?: number;
};

/**
 * One pass of ISA's background work:
 * 1. check meeting bots that are scheduled or in a call, and store finished transcripts as events;
 * 2. read new Slack messages and emails, and schedule the bot for upcoming calendar meetings;
 * 3. sort every new event and draft its proposals.
 * Errors in one source are logged and never stop the rest.
 */
export async function tick(deps: WorkerDeps) {
  const every = (n: number) => deps.pass === undefined || deps.pass % n === 0;
  const started = Date.now();
  const google =
    deps.google && every(3) && (await GoogleClient.connection().catch(logFailure("google connection", null))) ? deps.google : null;
  const transcripts = deps.recall ? await pollBots(deps.recall).catch(logFailure("bot")) : 0;
  const slack = deps.slack && every(3) ? await pollSlack(deps.slack).catch(logFailure("slack")) : 0;
  const email = google ? await pollGmail(google).catch(logFailure("gmail")) : 0;
  const meetings =
    google && deps.recall && every(12)
      ? await scheduleCalendarBots(google, deps.recall).catch(logFailure("calendar"))
      : 0;
  // Every 2 minutes, notice tickets deleted, moved along or finished in Jira.
  const jira = deps.jira && every(12) ? await syncJira(deps.jira).then((r) => r.unlinked + r.done).catch(logFailure("jira")) : 0;
  // Then record what people changed on ISA's tickets (from Jira's change history).
  // Changes to what a ticket says become an item ISA reviews with the owner.
  const ticketChanges =
    deps.jira && every(12)
      ? await trackJira(deps.jira)
          .then(async (r) => (deps.llm ? (await reviewJiraChanges(r.changes, deps.llm)).length : r.changes.length))
          .catch(logFailure("jira-track"))
      : 0;
  const processed = deps.llm ? await processNewEvents(deps.llm).catch(logFailure("events")) : 0;
  const result = { transcripts, slack, email, meetings, jira, ticketChanges, processed };
  const ms = Date.now() - started;
  // A line per pass that did something, so the logs show data arriving; quiet passes stay quiet.
  if (Object.values(result).some((n) => n > 0)) log.info("worker pass", { pass: deps.pass, ms, ...result });
  else log.debug("worker pass idle", { pass: deps.pass, ms });
  if (ms > 60_000) log.warn("worker pass slow", { pass: deps.pass, ms });
  return result;
}

function logFailure<T = number>(what: string, fallback: T = 0 as T) {
  return (err: unknown): T => {
    log.error(`${what} poll failed`, err, { source: what });
    return fallback;
  };
}

export async function pollBots(recall: RecallClient): Promise<number> {
  const active = await db
    .select()
    .from(schema.meetingBots)
    .where(inArray(schema.meetingBots.status, ["scheduled", "in_call", "processing"]));
  let stored = 0;
  for (const bot of active) {
    try {
      // A scheduled bot is only checked once its start time is near.
      if (bot.status === "scheduled" && bot.joinAt && bot.joinAt.getTime() - Date.now() > 2 * 60_000) continue;
      const state = await recall.getBotState(bot.recallBotId);
      if (state.status === "done" && state.transcriptUrl) {
        const segments = await recall.downloadTranscript(state.transcriptUrl);
        const { text, speakers } = formatTranscript(segments);
        const [event] = await db
          .insert(schema.events)
          .values({
            source: bot.platform,
            externalId: bot.recallBotId,
            title: bot.title,
            occurredAt: bot.joinAt ?? bot.createdAt,
            participants: speakers.map((name) => ({ name, email: null, slackUserId: null, role: null })),
            content: text || "(The transcript is empty: nobody spoke while ISA was in the call.)",
            url: bot.meetingUrl,
          })
          .onConflictDoNothing()
          .returning({ id: schema.events.id });
        await db
          .update(schema.meetingBots)
          .set({ status: "done", eventId: event?.id ?? null, error: null, updatedAt: new Date() })
          .where(eq(schema.meetingBots.id, bot.id));
        stored += 1;
        log.info("meeting transcript stored", { botId: bot.id, eventId: event?.id ?? null, segments: segments.length, speakers: speakers.length, empty: !text });
      } else if (state.status !== bot.status || state.detail !== bot.error) {
        log.info("meeting bot status changed", { botId: bot.id, platform: bot.platform, from: bot.status, to: state.status });
        if (state.status === "failed") log.warn("meeting bot failed", { botId: bot.id, platform: bot.platform, detail: state.detail?.slice(0, 120) ?? null });
        await db
          .update(schema.meetingBots)
          .set({ status: state.status, error: state.detail, updatedAt: new Date() })
          .where(eq(schema.meetingBots.id, bot.id));
      }
    } catch (err) {
      log.error("bot poll failed", err, { botId: bot.id, botStatus: bot.status });
    }
  }
  return stored;
}

export async function processNewEvents(llm: StructuredLLM): Promise<number> {
  const pending = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.status, "new"))
    .orderBy(asc(schema.events.occurredAt))
    .limit(10);
  let done = 0;
  // In order of occurrence, so an approval is sorted after the request it approves.
  for (const { id } of pending) {
    try {
      await processEvent(id, llm);
      done += 1;
    } catch {
      // processEvent logged the details; this line ties the failure to the worker pass.
      log.warn("event left failed", { eventId: id });
    }
  }
  return done;
}
