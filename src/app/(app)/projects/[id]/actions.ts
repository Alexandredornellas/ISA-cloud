"use server";

import { recordVersion } from "@/lib/versions";
import { setJiraKey } from "@/lib/jira-project";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";

export async function addRule(form: FormData) {
  const projectId = String(form.get("projectId"));
  const text = String(form.get("text") ?? "").trim();
  if (text) await db.insert(schema.projectRules).values({ projectId, text });
  revalidatePath("/", "layout");
}

export async function removeRule(form: FormData) {
  const projectId = String(form.get("projectId"));
  const id = String(form.get("id"));
  await db.delete(schema.projectRules).where(and(eq(schema.projectRules.id, id), eq(schema.projectRules.projectId, projectId)));
  revalidatePath("/", "layout");
}

export async function redraftItem(form: FormData) {
  const { redraftFromEvent } = await import("@/lib/brain/pipeline");
  const { claudeStructured } = await import("@/lib/brain/llm");
  const { liveSenders } = await import("@/lib/senders");
  const projectId = String(form.get("projectId"));
  await redraftFromEvent(String(form.get("eventId")), projectId, claudeStructured, liveSenders().jira);
  revalidatePath("/", "layout");
  const { redirect } = await import("next/navigation");
  redirect(`/?c=${projectId}`);
}

/** The owner sets a requirement's status by hand. This changes ISA's record only, not Jira. */
export async function setRequirementStatus(form: FormData) {
  const id = String(form.get("id"));
  const status = String(form.get("status"));
  if (!["proposed", "approved", "done", "dropped"].includes(status)) return;
  const before = await db.query.requirements.findFirst({ where: eq(schema.requirements.id, id) });
  if (!before) return;
  const [row] = await db
    .update(schema.requirements)
    .set({
      status: status as "proposed" | "approved" | "done" | "dropped",
      approvedBy: status === "approved" ? "you" : undefined,
      updatedAt: new Date(),
    })
    .where(eq(schema.requirements.id, id))
    .returning();
  if (row) await recordVersion(row, { changedBy: "you", reason: `Status set to ${status} by hand` }, before);
  revalidatePath("/", "layout");
}

/** Which Jira project this ISA project creates tickets in ("" goes back to the default). */
export async function setJiraProject(form: FormData) {
  await setJiraKey(String(form.get("projectId")), String(form.get("key") ?? ""));
  revalidatePath("/", "layout");
}
