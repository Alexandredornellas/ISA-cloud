import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { processEvent } from "@/lib/brain/pipeline";
import type { StructuredLLM } from "@/lib/brain/llm";
import { formatTranscript, type RecallClient } from "@/lib/recall";
import type { SlackClient } from "@/lib/slack";
import { pollSlack } from "@/lib/slack-poll";

export type WorkerDeps = {
  recall: RecallClient | null;
  slack: SlackClient | null;
  llm: StructuredLLM | null;
  /** Read Slack on this pass (Slack is read every 30 seconds to stay inside its rate limits). */
  readSlack?: boolean;
};

/**
 * One pass of ISA's background work:
 * 1. check meeting bots that are scheduled or in a call, and store finished transcripts as events;
 * 2. read new Slack messages;
 * 3. sort every new event and draft its proposals.
 * Errors on one item are recorded on that item and never stop the rest.
 */
export async function tick(deps: WorkerDeps): Promise<{ transcripts: number; slack: number; processed: number }> {
  const transcripts = deps.recall ? await pollBots(deps.recall) : 0;
  const slack = deps.slack && deps.readSlack !== false ? await pollSlack(deps.slack).catch(logFailure("slack")) : 0;
  const processed = deps.llm ? await processNewEvents(deps.llm) : 0;
  return { transcripts, slack, processed };
}

function logFailure(what: string) {
  return (err: unknown) => {
    console.error(`${what} poll failed`, { error: err instanceof Error ? err.name : "unknown" });
    return 0;
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
      } else if (state.status !== bot.status || state.detail !== bot.error) {
        await db
          .update(schema.meetingBots)
          .set({ status: state.status, error: state.detail, updatedAt: new Date() })
          .where(eq(schema.meetingBots.id, bot.id));
      }
    } catch (err) {
      console.error("bot poll failed", { botId: bot.id, error: err instanceof Error ? err.name : "unknown" });
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
    } catch (err) {
      console.error("event processing failed", { eventId: id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return done;
}
