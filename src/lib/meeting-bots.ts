// Helpers around the meeting bots ISA has sent: one bot per meeting, and making a bot leave.
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { meetingKey, type RecallClient } from "@/lib/recall";

/** Two join times this close are the same meeting; further apart, a reused link is another meeting. */
const SAME_MEETING_MS = 20 * 60_000;

/**
 * A bot already in this meeting or about to join it, so ISA never sends a second one (two bots
 * in a call give two transcripts of the same conversation).
 */
export async function botAlreadyFor(meetingUrl: string, joinAt: Date, now = Date.now()): Promise<{ id: string; status: string } | null> {
  const key = meetingKey(meetingUrl);
  const active = await db
    .select({ id: schema.meetingBots.id, status: schema.meetingBots.status, url: schema.meetingBots.meetingUrl, joinAt: schema.meetingBots.joinAt, createdAt: schema.meetingBots.createdAt })
    .from(schema.meetingBots)
    .where(inArray(schema.meetingBots.status, ["scheduled", "in_call"]));
  const hit = active.find((b) => {
    if (meetingKey(b.url) !== key) return false;
    // A bot in the call now clashes with joining now; otherwise compare the planned times.
    if (b.status === "in_call" && Math.abs(joinAt.getTime() - now) < SAME_MEETING_MS) return true;
    return Math.abs((b.joinAt ?? b.createdAt).getTime() - joinAt.getTime()) < SAME_MEETING_MS;
  });
  return hit ? { id: hit.id, status: hit.status } : null;
}

/** Make a bot leave its call now. The worker then picks up the transcript as after any call. */
export async function leaveMeeting(botRowId: string, recall: Pick<RecallClient, "leaveCall">): Promise<void> {
  const bot = await db.query.meetingBots.findFirst({ where: eq(schema.meetingBots.id, botRowId) });
  if (!bot) throw new Error("Meeting not found");
  if (bot.status !== "in_call") throw new Error("ISA Notetaker is not in this call");
  await recall.leaveCall(bot.recallBotId);
  await db.update(schema.meetingBots).set({ status: "processing", error: null, updatedAt: new Date() }).where(eq(schema.meetingBots.id, bot.id));
}
