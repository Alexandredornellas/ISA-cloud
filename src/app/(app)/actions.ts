"use server";

import { eq, and, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { executeProposal, retryFailedActions } from "@/lib/executor";
import { liveSenders } from "@/lib/senders";
import { confirmClarification } from "@/lib/brain/pipeline";
import { claudeStructured } from "@/lib/brain/llm";

export async function approveProposal(form: FormData) {
  const id = String(form.get("id"));
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
  if (proposal?.kind === "clarify") {
    await confirmClarification(id, claudeStructured);
  } else {
    await executeProposal(id, liveSenders());
  }
  revalidatePath("/", "layout");
}

export async function dismissProposal(form: FormData) {
  const id = String(form.get("id"));
  await db
    .update(schema.proposals)
    .set({ status: "dismissed", decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, id), eq(schema.proposals.status, "pending")));
  revalidatePath("/", "layout");
}

export async function retryProposal(form: FormData) {
  const id = String(form.get("id"));
  await retryFailedActions(id, liveSenders());
  revalidatePath("/", "layout");
}

export async function answerTicketTypeQuestion(form: FormData) {
  const { answerMissingIssueType } = await import("@/lib/executor");
  const proposalId = String(form.get("proposalId"));
  const wanted = String(form.get("wanted"));
  const choice = String(form.get("choice"));
  const remember = form.get("remember") === "on";
  await answerMissingIssueType(proposalId, wanted, choice === "__skip" ? { skip: true } : { useType: choice }, remember, liveSenders());
  revalidatePath("/", "layout");
}

/** "Do it" on a card: carry out only the steps the owner kept, with their epic choice. */
export async function proceedNotification(form: FormData) {
  const { saveChoices } = await import("@/lib/choices");
  const id = String(form.get("id"));
  const keep = form.getAll("keep").map(Number).filter((n) => Number.isInteger(n));
  const mode = String(form.get("epicMode") ?? "");
  const epic =
    mode === "new"
      ? { mode: "new" as const, name: String(form.get("epicName") ?? "") }
      : mode === "existing"
        ? { mode: "existing" as const, key: String(form.get("epicKey") ?? "") }
        : null;
  await saveChoices(id, { keep, epic });
  await executeProposal(id, liveSenders());
  revalidatePath("/", "layout");
}

/** "Not needed" on a card: a draft is dismissed, a failure is put aside. Either way it leaves the channel. */
export async function dismissNotification(form: FormData) {
  const id = String(form.get("id"));
  await db
    .update(schema.proposals)
    .set({ status: "dismissed", decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, id), inArray(schema.proposals.status, ["pending", "failed"])));
  revalidatePath("/", "layout");
}

/** "File it there" on a "where does this go?" card. */
export async function placeNotification(form: FormData) {
  const { placeClarification } = await import("@/lib/brain/pipeline");
  const id = String(form.get("id"));
  const target = String(form.get("target") ?? "");
  const name = String(form.get("newProjectName") ?? "").trim();
  await placeClarification(id, target === "new" ? { newProjectName: name || "New project" } : { projectId: target }, claudeStructured);
  revalidatePath("/", "layout");
}
