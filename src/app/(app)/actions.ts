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

/** The ticket details the owner confirmed on a card (fields named d<step>_<field>). */
function detailsFrom(form: FormData, steps: number[]) {
  const out: Record<number, import("@/lib/choices").DetailChoice> = {};
  for (const i of steps) {
    const get = (f: string) => (form.has(`d${i}_${f}`) ? String(form.get(`d${i}_${f}`) ?? "").trim() : undefined);
    const d: import("@/lib/choices").DetailChoice = {};
    const epic = get("epic");
    if (epic !== undefined) d.epic = epic || null;
    const sprint = get("sprint");
    if (sprint !== undefined) d.sprint = sprint || null;
    const points = get("points");
    if (points !== undefined) d.storyPoints = points && Number.isFinite(Number(points)) ? Number(points) : null;
    const links = get("links");
    if (links !== undefined) d.links = [...new Set(links.toUpperCase().match(/[A-Z][A-Z0-9_]+-\d+/g) ?? [])];
    const names = form.getAll(`d${i}_xname`).map(String);
    if (names.length) d.extra = names.map((name, j) => ({ name, value: String(form.getAll(`d${i}_xvalue`)[j] ?? "").trim() }));
    if (Object.keys(d).length) out[i] = d;
  }
  return out;
}

/** "Do it" on a card: carry out only the steps the owner kept, with their epic choice and ticket details. */
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
  const projects: Record<number, string> = {};
  for (const i of keep) if (form.has(`p${i}`)) projects[i] = String(form.get(`p${i}`) ?? "");
  await saveChoices(id, { keep, epic, details: detailsFrom(form, keep), projects });
  await executeProposal(id, liveSenders());
  revalidatePath("/", "layout");
}

/**
 * "Move them there" on a card that suggested a new Jira project: the owner created it (or picked
 * another) and typed its key. Only ISA's draft changes; nothing is sent to Jira.
 */
export async function moveCardToJiraProject(id: string, key: string): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  const { adoptJiraProject } = await import("@/lib/jira-project");
  const r = await adoptJiraProject(key, { proposalId: id });
  if (r.ok) revalidatePath("/", "layout");
  return r.ok ? { ok: true, moved: r.moved } : r;
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
