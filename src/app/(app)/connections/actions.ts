"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { importPage } from "@/lib/confluence";
import { db, schema } from "@/db";
import { RecallClient, platformOf, recallConfigFromEnv } from "@/lib/recall";
import { botAlreadyFor, leaveMeeting } from "@/lib/meeting-bots";
import { log } from "@/lib/log";

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
    const already = await botAlreadyFor(meetingUrl, joinAt ?? new Date());
    if (already) {
      return { ok: false, error: already.status === "in_call" ? "ISA Notetaker is already in this meeting." : "ISA Notetaker is already on its way to this meeting." };
    }
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
  revalidatePath("/", "layout");
  return { ok: true, error: null };
}

/** "Leave the call" on the Meetings page: the bot leaves now and ISA reads the transcript. */
export async function leaveMeetingAction(form: FormData) {
  try {
    await leaveMeeting(String(form.get("id") ?? ""), new RecallClient(recallConfigFromEnv()));
  } catch (err) {
    log.error("leave meeting failed", err);
  }
  revalidatePath("/", "layout");
}

/** Turn calendar auto-join on or off. */
export async function setAutoJoin(form: FormData) {
  const { GoogleClient } = await import("@/lib/google");
  const conn = await GoogleClient.connection();
  if (!conn) return;
  const on = form.get("on") === "on";
  await db
    .update(schema.connections)
    .set({ state: { ...conn.state, autoJoin: on ? "on" : "off" }, updatedAt: new Date() })
    .where(eq(schema.connections.id, conn.id));
  revalidatePath("/", "layout");
}

/** Add a Confluence page (read-only) to ISA's memory; the worker files it under projects. */
export async function addConfluencePage(form: FormData) {
  const page = String(form.get("page") ?? "").trim();
  if (!page) return;
  let message: string;
  try {
    const r = await importPage(page);
    message = r.added ? `Added “${r.title}”. ISA files it under its projects in a few seconds.` : `“${r.title}” is already in memory.`;
  } catch (err) {
    message = err instanceof Error ? err.message : "Could not add the page";
  }
  revalidatePath("/", "layout");
  redirect(`/connections?confluence=${encodeURIComponent(message)}`);
}
