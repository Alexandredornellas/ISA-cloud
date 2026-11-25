"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { claudeStructured } from "@/lib/brain/llm";
import { DIAGRAM_KINDS, drawDiagram, type DiagramKind } from "@/lib/brain/diagram";
import { log } from "@/lib/log";

export async function newDiagram(form: FormData) {
  const [projectId, requirementId] = String(form.get("target") ?? "").split(":");
  const kind = String(form.get("kind") ?? "flow") as DiagramKind;
  if (!projectId || !(kind in DIAGRAM_KINDS)) return;
  let target: string;
  try {
    const d = await drawDiagram(claudeStructured, { projectId, requirementId: requirementId || null, kind, ask: String(form.get("ask") ?? "") });
    target = `/diagrams#d-${d.id}`;
  } catch (err) {
    log.error("diagram failed", err);
    target = `/diagrams?error=${encodeURIComponent(err instanceof Error ? err.message : "ISA could not draw it")}`;
  }
  revalidatePath("/diagrams");
  redirect(target);
}

export async function deleteDiagram(form: FormData) {
  await db.delete(schema.diagrams).where(eq(schema.diagrams.id, String(form.get("id"))));
  revalidatePath("/diagrams");
}
