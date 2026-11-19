"use server";

import { revalidatePath } from "next/cache";
import { clearChat, sendChat } from "@/lib/brain/chat";

/** Returns an error to show, or null. Errors are returned, not thrown, so the message reaches the page. */
export async function sendChatMessage(form: FormData): Promise<string | null> {
  const text = String(form.get("text") ?? "").trim();
  if (!text) return null;
  try {
    await sendChat(text);
  } catch (err) {
    console.error("chat failed", { error: err instanceof Error ? err.name : "unknown" });
    return "ISA could not answer. Check the Anthropic key on the Connections page and try again.";
  }
  revalidatePath("/", "layout");
  return null;
}

export async function clearChatMessages() {
  await clearChat();
  revalidatePath("/chat");
}
