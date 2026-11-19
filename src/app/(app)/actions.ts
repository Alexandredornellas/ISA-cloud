"use server";

import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { executeProposal, retryFailedActions } from "@/lib/executor";
import { liveSenders } from "@/lib/senders";

export async function approveProposal(form: FormData) {
  const id = String(form.get("id"));
  await executeProposal(id, liveSenders());
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
