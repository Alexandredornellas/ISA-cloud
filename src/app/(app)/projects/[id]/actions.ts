"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";

export async function addRule(form: FormData) {
  const projectId = String(form.get("projectId"));
  const text = String(form.get("text") ?? "").trim();
  if (text) await db.insert(schema.projectRules).values({ projectId, text });
  revalidatePath(`/projects/${projectId}`);
}

export async function removeRule(form: FormData) {
  const projectId = String(form.get("projectId"));
  const id = String(form.get("id"));
  await db.delete(schema.projectRules).where(and(eq(schema.projectRules.id, id), eq(schema.projectRules.projectId, projectId)));
  revalidatePath(`/projects/${projectId}`);
}

export async function redraftItem(form: FormData) {
  const { redraftFromEvent } = await import("@/lib/brain/pipeline");
  const { claudeStructured } = await import("@/lib/brain/llm");
  const { liveSenders } = await import("@/lib/senders");
  const projectId = String(form.get("projectId"));
  await redraftFromEvent(String(form.get("eventId")), projectId, claudeStructured, liveSenders().jira);
  revalidatePath("/", "layout");
  const { redirect } = await import("next/navigation");
  redirect("/");
}
