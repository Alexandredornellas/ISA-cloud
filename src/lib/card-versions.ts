// Versions of a waiting suggestion ("card"). Nothing on a card changes silently: every change
// (new items, the owner's correction, a Jira project move) adds a version saying what changed, why,
// and what caused it, and the owner can carry out the latest one or go back to an earlier one.
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeAction, type Action, type Plan } from "@/lib/plan";

export type VersionCause = "drafted" | "new_items" | "correction" | "jira_project" | "restored";
export type CardVersion = typeof schema.proposalVersions.$inferSelect;

/**
 * Save a change to a waiting suggestion as a new version, and make it the card's plan. The first
 * change also saves the plan it replaced as version 1. Returns the new version number.
 */
export async function saveCardVersion(
  proposalId: string,
  before: Plan,
  after: Plan,
  change: { cause: VersionCause; reason: string; eventIds?: string[] },
  extra: Partial<typeof schema.proposals.$inferInsert> = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ version: schema.proposalVersions.version })
      .from(schema.proposalVersions)
      .where(eq(schema.proposalVersions.proposalId, proposalId))
      .orderBy(desc(schema.proposalVersions.version))
      .limit(1);
    let version = last?.version ?? 0;
    if (!last) {
      const p = await tx.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId), columns: { eventIds: true } });
      await tx.insert(schema.proposalVersions).values({
        proposalId,
        version: ++version,
        plan: before,
        cause: "drafted",
        reason: "ISA's first draft.",
        eventIds: (p?.eventIds ?? []).filter((id) => !(change.eventIds ?? []).includes(id)),
      });
    }
    await tx.insert(schema.proposalVersions).values({
      proposalId,
      version: ++version,
      plan: after,
      cause: change.cause,
      reason: change.reason,
      eventIds: change.eventIds ?? [],
    });
    await tx
      .update(schema.proposals)
      .set({ ...extra, plan: after, previousPlan: before, updatedAt: new Date() })
      .where(eq(schema.proposals.id, proposalId));
    return version;
  });
}

/** A card's versions, oldest first; empty when it never changed. */
export async function cardVersions(proposalIds: string[]): Promise<Map<string, CardVersion[]>> {
  const out = new Map<string, CardVersion[]>();
  if (!proposalIds.length) return out;
  const rows = await db
    .select()
    .from(schema.proposalVersions)
    .where(inArray(schema.proposalVersions.proposalId, proposalIds))
    .orderBy(asc(schema.proposalVersions.version));
  for (const r of rows) out.set(r.proposalId, [...(out.get(r.proposalId) ?? []), r]);
  return out;
}

/**
 * Go back to an earlier version: it becomes the card's plan again, as a new version, so the history
 * shows the owner chose it. Only a waiting suggestion can change.
 */
export async function restoreCardVersion(proposalId: string, version: number): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || proposal.status !== "pending") return { ok: false, error: "This suggestion is no longer waiting for you." };
  const all = (await cardVersions([proposalId])).get(proposalId) ?? [];
  const chosen = all.find((v) => v.version === version);
  if (!chosen) return { ok: false, error: `There is no version ${version}.` };
  if (chosen.version === all.at(-1)?.version) return { ok: true, version };
  const n = await saveCardVersion(proposalId, proposal.plan, chosen.plan, {
    cause: "restored",
    reason: `You went back to version ${version}.`,
  });
  return { ok: true, version: n };
}

const stepId = (a: Action) => ("requirementRef" in a ? `${a.type}:${a.requirementRef}` : `${a.type}:${describeAction(a)}`);
const textOf = (a: Action) =>
  a.type === "jira_create" || a.type === "jira_update"
    ? `${a.summary ?? ""}\n${a.description ?? ""}`
    : a.type === "jira_comment"
      ? a.body
      : a.type === "slack_message"
        ? a.text
        : a.type === "email"
          ? `${a.subject}\n${a.body}`
          : a.reason;
const name = (a: Action) => describeAction(a.type === "jira_create" ? { ...a, jiraProject: "", epicRef: null } : a);
const where = (a: Action) => (a.type === "jira_create" ? a.jiraProject || "the default project" : "");

/** What changed from one version to the next, one line per change, in plain words. */
export function versionChanges(before: Plan, after: Plan): string[] {
  const out: string[] = [];
  const was = new Map(before.actions.map((a) => [stepId(a), a]));
  const now = new Set(after.actions.map(stepId));
  for (const a of after.actions) {
    const old = was.get(stepId(a));
    if (!old) {
      out.push(`Added: ${describeAction(a, after)}`);
      continue;
    }
    if (where(old) !== where(a)) out.push(`${name(a)}: ${where(old)} → ${where(a)}`);
    if (old.type === "jira_create" && a.type === "jira_create" && old.summary !== a.summary) out.push(`Renamed: "${old.summary}" → "${a.summary}"`);
    else if (textOf(old) !== textOf(a)) out.push(`Text changed: ${name(a)}`);
  }
  for (const a of before.actions) if (!now.has(stepId(a))) out.push(`Removed: ${describeAction(a, before)}`);
  const asked = new Set(before.openQuestions);
  const added = after.openQuestions.filter((q) => !asked.has(q)).length;
  const gone = before.openQuestions.filter((q) => !after.openQuestions.includes(q)).length;
  if (added) out.push(`${added} new open ${added === 1 ? "question" : "questions"}`);
  if (gone) out.push(`${gone} open ${gone === 1 ? "question" : "questions"} answered or dropped`);
  if (before.newJiraProject?.key !== after.newJiraProject?.key) {
    out.push(after.newJiraProject ? `Suggests a new Jira project: ${after.newJiraProject.key}` : `No longer suggests Jira project ${before.newJiraProject?.key}`);
  }
  return out;
}
