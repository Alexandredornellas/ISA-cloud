"use server";

import { revalidatePath } from "next/cache";
import { clearChat, sendChat } from "@/lib/brain/chat";
import { log } from "@/lib/log";

/** Returns an error to show, or null. Errors are returned, not thrown, so the message reaches the page. */
export async function sendChatMessage(form: FormData): Promise<string | null> {
  const text = String(form.get("text") ?? "").trim();
  if (!text) return null;
  try {
    await sendChat(text, projectIdOf(form), idOf(form, "proposalId"));
  } catch (err) {
    log.error("chat failed", err);
    return "ISA could not answer. Check the Anthropic key on the Connections page and try again.";
  }
  revalidatePath("/", "layout");
  return null;
}

export async function clearChatMessages(form: FormData) {
  await clearChat(projectIdOf(form));
  revalidatePath("/", "layout");
}

function projectIdOf(form: FormData): string | null {
  const id = String(form.get("projectId") ?? "");
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

function idOf(form: FormData, name: string): string | null {
  const id = String(form.get(name) ?? "");
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
