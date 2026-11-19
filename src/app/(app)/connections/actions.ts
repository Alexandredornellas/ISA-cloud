"use server";

import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { RecallClient, platformOf, recallConfigFromEnv } from "@/lib/recall";

export type SendBotState = { error: string | null; ok: boolean };

/** Send the visible "ISA Notetaker" bot to a Zoom, Meet or Teams call, now or at a start time. */
export async function sendBotToMeeting(_prev: SendBotState, form: FormData): Promise<SendBotState> {
  const meetingUrl = String(form.get("meetingUrl") ?? "").trim();
  const title = String(form.get("title") ?? "").trim() || "Meeting";
  const startsAt = String(form.get("startsAt") ?? "").trim();
  const platform = platformOf(meetingUrl);
  if (!platform) return { ok: false, error: "Paste a Zoom, Google Meet or Teams link." };

  let joinAt: Date | null = null;
  if (startsAt) {
    joinAt = new Date(startsAt);
    if (Number.isNaN(joinAt.getTime())) return { ok: false, error: "The start time is not valid." };
    if (joinAt.getTime() <= Date.now()) joinAt = null;
  }

  try {
    const recall = new RecallClient(recallConfigFromEnv());
    const bot = await recall.createBot(meetingUrl, joinAt);
    await db.insert(schema.meetingBots).values({
      recallBotId: bot.id,
      meetingUrl,
      title,
      platform,
      joinAt: joinAt ?? new Date(),
      status: "scheduled",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not send the bot." };
  }
  revalidatePath("/connections");
  return { ok: true, error: null };
}
