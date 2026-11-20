"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { TICKET_KINDS, type TicketKind } from "@/lib/ticket-formats";

function kindOf(form: FormData): TicketKind {
  const kind = String(form.get("kind"));
  if (!TICKET_KINDS.includes(kind as TicketKind)) throw new Error("Unknown ticket kind");
  return kind as TicketKind;
}

export async function saveTicketFormat(form: FormData) {
  const kind = kindOf(form);
  const values = {
    kind,
    jiraIssueType: String(form.get("jiraIssueType") ?? "").trim() || "Task",
    label: String(form.get("label") ?? "").trim() || null,
    template: String(form.get("template") ?? "").trim(),
    updatedAt: new Date(),
  };
  if (!values.template) return;
  await db.insert(schema.ticketFormats).values(values).onConflictDoUpdate({ target: schema.ticketFormats.kind, set: values });
  revalidatePath("/settings");
}

export async function resetTicketFormat(form: FormData) {
  await db.delete(schema.ticketFormats).where(eq(schema.ticketFormats.kind, kindOf(form)));
  revalidatePath("/settings");
}
