"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { saveSettings } from "@/lib/settings";
import { DEFAULT_FORMATS, saveTicketFormat as save, TICKET_KINDS, type TicketKind } from "@/lib/ticket-formats";

function kindOf(form: FormData): TicketKind {
  const kind = String(form.get("kind"));
  if (!TICKET_KINDS.includes(kind as TicketKind)) throw new Error("Unknown ticket kind");
  return kind as TicketKind;
}

export async function saveTicketFormat(form: FormData) {
  const kind = kindOf(form);
  const template = String(form.get("template") ?? "").trim();
  if (!template) return;
  await save({
    kind,
    name: String(form.get("name") ?? "").trim() || DEFAULT_FORMATS[kind].name,
    jiraIssueType: String(form.get("jiraIssueType") ?? "").trim() || "Task",
    label: String(form.get("label") ?? "").trim() || null,
    template,
  });
  revalidatePath("/settings");
}

export async function resetTicketFormat(form: FormData) {
  await db.delete(schema.ticketFormats).where(eq(schema.ticketFormats.kind, kindOf(form)));
  revalidatePath("/settings");
}

export async function saveDraftingSettings(form: FormData) {
  const on = (k: string) => form.get(k) === "on";
  await saveSettings({
    askEpic: on("askEpic"),
    askSprint: on("askSprint"),
    askStoryPoints: on("askStoryPoints"),
    askLinks: on("askLinks"),
    askCustom: [...form.getAll("askCustom").map(String), String(form.get("newCustom") ?? "")],
  });
  revalidatePath("/settings");
}
