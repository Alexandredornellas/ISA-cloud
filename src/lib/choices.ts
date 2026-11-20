import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Plan } from "@/lib/plan";

/** What the owner chose on a suggestion card before saying "Do it". */
export type Choices = {
  /** Positions (in plan.actions) of the steps to carry out; the rest are dropped. */
  keep: number[];
  /** For a suggestion that creates an epic: keep it (optionally renamed), or use an existing epic instead. */
  epic?: { mode: "new"; name: string } | { mode: "existing"; key: string } | null;
};

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * The plan as the owner wants it carried out: only the kept steps, with the epic renamed or
 * replaced by an existing one. Tickets that pointed at a dropped epic go under the chosen one,
 * or under none.
 */
export function applyChoices(plan: Plan, choices: Choices): Plan {
  const keep = new Set(choices.keep);
  let actions = plan.actions.filter((_, i) => keep.has(i));
  let requirementChanges = plan.requirementChanges;

  const epicRefs = new Set(plan.actions.flatMap((a) => (a.type === "jira_create" && a.kind === "epic" ? [a.requirementRef] : [])));
  const epic = choices.epic;

  if (epic?.mode === "new" && epic.name.trim()) {
    actions = actions.map((a) => (a.type === "jira_create" && a.kind === "epic" ? { ...a, summary: epic.name.trim() } : a));
  }
  if (epic?.mode === "existing" && JIRA_KEY.test(epic.key)) {
    actions = actions
      .filter((a) => !(a.type === "jira_create" && a.kind === "epic"))
      .map((a) => (a.type === "jira_create" && a.epicRef && epicRefs.has(a.epicRef) ? { ...a, epicRef: epic.key } : a));
    // The epic's own requirement goes too, unless another kept step still needs it.
    const used = new Set(actions.map((a) => ("requirementRef" in a ? a.requirementRef : "")));
    requirementChanges = requirementChanges.filter((r) => !(epicRefs.has(r.ref) && !used.has(r.ref)));
  }

  // A ticket whose epic is no longer created in this plan cannot point at it.
  const created = new Set(actions.flatMap((a) => (a.type === "jira_create" && a.kind === "epic" ? [a.requirementRef] : [])));
  actions = actions.map((a) =>
    a.type === "jira_create" && a.epicRef && !JIRA_KEY.test(a.epicRef) && !created.has(a.epicRef) ? { ...a, epicRef: null } : a,
  );

  return { ...plan, actions, requirementChanges };
}

/** Save the owner's choices on a pending suggestion, so "Do it" carries out exactly that. */
export async function saveChoices(proposalId: string, choices: Choices): Promise<Plan> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || proposal.status !== "pending") throw new Error("This suggestion is no longer waiting for you");
  const plan = applyChoices(proposal.plan, choices);
  await db.update(schema.proposals).set({ plan, updatedAt: new Date() }).where(eq(schema.proposals.id, proposalId));
  return plan;
}
