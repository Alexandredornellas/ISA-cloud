import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { addProjectPeople } from "@/lib/people";
import { recordVersion } from "@/lib/versions";
import type { Action, Person, Plan, TicketDetails } from "@/lib/plan";
import { MissingIssueTypeError, type JiraClient } from "@/lib/jira";
import { recordIsaWrite } from "@/lib/jira-track";
import { saveTicketFormat, ticketFormats, type TicketKind } from "@/lib/ticket-formats";

// Outside services the executor can act on. Slack and email are wired in later.
export type Senders = {
  jira: JiraClient | null;
  slack: { postMessage(channel: string, text: string, threadTs: string | null): Promise<{ ts: string }> } | null;
  email: {
    send(input: { to: string[]; subject: string; body: string; threadId: string | null }): Promise<{ id: string }>;
  } | null;
};

export type ExecutionResult = { projectId: string; ok: boolean; errors: string[] };

/**
 * Carry out an approved proposal: create the project if needed, apply the requirement
 * changes, then run each outside action in order. Every action is logged, and a failed
 * action does not stop the ones after it.
 */
export async function executeProposal(proposalId: string, senders: Senders): Promise<ExecutionResult> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending") throw new Error(`Proposal is already ${proposal.status}`);

  await db
    .update(schema.proposals)
    .set({ status: "approved", decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.proposals.id, proposalId));

  const plan = proposal.plan;
  const projectId = await ensureProject(proposal.projectId, plan, proposal.eventIds);
  let refToRequirement: Map<string, RequirementRow>;
  if (proposal.memoryAppliedAt) {
    // The project's memory was saved when the item was filed: only the outside steps are left.
    refToRequirement = await savedRefs(projectId, proposal.refs);
  } else {
    refToRequirement = await applyRequirementChanges(projectId, plan, { proposalId, eventIds: proposal.eventIds });
    const refs: Record<string, string> = {};
    for (const [ref, row] of refToRequirement) refs[ref] = row.id;
    await db.update(schema.proposals).set({ projectId, refs, memoryAppliedAt: new Date() }).where(eq(schema.proposals.id, proposalId));
  }

  const rows = plan.actions.length === 0 ? [] : await db
    .insert(schema.actions)
    .values(plan.actions.map((action, position) => ({ proposalId, projectId, type: action.type, position, payload: action })))
    .returning({ id: schema.actions.id, payload: schema.actions.payload, position: schema.actions.position });
  rows.sort((a, b) => a.position - b.position);

  return runActions(proposalId, projectId, rows, refToRequirement, senders);
}

/** Requirements by id, plus the plan's temporary refs ("R1") mapped to the rows they became. */
async function savedRefs(projectId: string, refs: Record<string, string>): Promise<Map<string, RequirementRow>> {
  const reqs = await db.query.requirements.findMany({ where: eq(schema.requirements.projectId, projectId) });
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const out = new Map<string, RequirementRow>(reqs.map((r) => [r.id, r]));
  for (const [ref, id] of Object.entries(refs)) {
    const row = byId.get(id);
    if (row) out.set(ref, row);
  }
  return out;
}

/**
 * Save what a filed item means for its project, right away and without approval: requirement
 * changes (with their reasons, which become the decision trail) and the people involved. Nothing
 * leaves ISA here. The Jira steps and messages stay on the card as optional suggestions; a draft
 * with none is closed. Safe to call again after the draft is merged with newer items.
 */
export async function recordMemory(proposalId: string): Promise<void> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || proposal.status !== "pending" || proposal.kind === "clarify" || !proposal.projectId) return;
  const projectId = proposal.projectId;
  const existing = new Set((await db.select({ id: schema.requirements.id }).from(schema.requirements).where(eq(schema.requirements.projectId, projectId))).map((r) => r.id));
  // A ref saved earlier (or a real id) is now an update, so merged drafts do not duplicate.
  const changes = proposal.plan.requirementChanges.map((c) => {
    const id = proposal.refs[c.ref] ?? c.ref;
    return existing.has(id) ? { ...c, ref: id, op: c.op === "create" ? ("update" as const) : c.op } : c;
  });
  const applied = await applyRequirementChanges(projectId, { ...proposal.plan, requirementChanges: changes }, { proposalId, eventIds: proposal.eventIds });
  const refs: Record<string, string> = { ...proposal.refs };
  for (const c of proposal.plan.requirementChanges) {
    const row = applied.get(proposal.refs[c.ref] ?? c.ref) ?? applied.get(c.ref);
    if (row) refs[c.ref] = row.id;
  }
  if (proposal.plan.people.length) await ensureProject(projectId, proposal.plan, []);
  const nothingLeft = proposal.plan.actions.length === 0;
  await db
    .update(schema.proposals)
    .set({
      refs,
      memoryAppliedAt: new Date(),
      updatedAt: new Date(),
      ...(nothingLeft ? { status: "executed" as const, decidedAt: new Date() } : {}),
    })
    .where(eq(schema.proposals.id, proposalId));
}

/** Run the failed actions of a proposal again, for example after connecting Jira. */
export async function retryFailedActions(proposalId: string, senders: Senders): Promise<ExecutionResult> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || !proposal.projectId) throw new Error("Proposal not found or never approved");
  if (proposal.status !== "failed") throw new Error(`Proposal is ${proposal.status}, nothing to retry`);

  const reqs = await db.query.requirements.findMany({
    where: eq(schema.requirements.projectId, proposal.projectId),
  });
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const refToRequirement = new Map<string, RequirementRow>(reqs.map((r) => [r.id, r]));
  for (const [ref, id] of Object.entries(proposal.refs)) {
    const row = byId.get(id);
    if (row) refToRequirement.set(ref, row);
  }

  const failed = await db
    .select({ id: schema.actions.id, payload: schema.actions.payload })
    .from(schema.actions)
    .where(and(eq(schema.actions.proposalId, proposalId), eq(schema.actions.status, "failed")))
    .orderBy(asc(schema.actions.position));

  return runActions(proposalId, proposal.projectId, failed, refToRequirement, senders);
}

async function runActions(
  proposalId: string,
  projectId: string,
  rows: { id: string; payload: unknown }[],
  refToRequirement: Map<string, RequirementRow>,
  senders: Senders,
): Promise<ExecutionResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    try {
      const result = await runAction(row.payload as Action, refToRequirement, senders);
      if (Array.isArray(result.warnings)) warnings.push(...(result.warnings as string[]));
      await db
        .update(schema.actions)
        .set({ status: "done", result, error: null, updatedAt: new Date() })
        .where(eq(schema.actions.id, row.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      // A missing Jira ticket type becomes a question for the owner instead of a plain failure.
      const question: ActionQuestion | null =
        err instanceof MissingIssueTypeError
          ? { kind: "missing_issue_type", projectKey: err.projectKey, wanted: err.wanted, available: err.available }
          : null;
      await db
        .update(schema.actions)
        .set({ status: "failed", error: message, result: question ? { question } : null, updatedAt: new Date() })
        .where(eq(schema.actions.id, row.id));
    }
  }

  // The proposal is done only when none of its actions is still failed.
  const stillFailed = await db
    .select({ id: schema.actions.id })
    .from(schema.actions)
    .where(and(eq(schema.actions.proposalId, proposalId), eq(schema.actions.status, "failed")));
  const unique = [...new Set(errors)];
  await db
    .update(schema.proposals)
    .set({
      status: stillFailed.length ? "failed" : "executed",
      // A done proposal can still carry notes, e.g. a sprint Jira would not set.
      error: stillFailed.length ? unique.join("\n") : warnings.length ? warnings.join("\n") : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.proposals.id, proposalId));

  return { projectId, ok: stillFailed.length === 0, errors: unique };
}

async function ensureProject(projectId: string | null, plan: Plan, eventIds: string[]): Promise<string> {
  let id = projectId;
  if (!id) {
    const [p] = await db
      .insert(schema.projects)
      .values({
        name: plan.projectName ?? "New project",
        summary: plan.summary,
        people: mergePeople([], plan.people),
        jiraProjectKey: process.env.JIRA_PROJECT_KEY ?? null,
      })
      .returning({ id: schema.projects.id });
    id = p.id;
  } else if (plan.people.length) {
    const current = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (current) {
      await db
        .update(schema.projects)
        .set({ people: mergePeople(current.people, plan.people), updatedAt: new Date() })
        .where(eq(schema.projects.id, id));
    }
  }
  if (plan.people.length) await addProjectPeople(id, plan.people);
  if (eventIds.length) {
    await db
      .insert(schema.eventProjects)
      .values(eventIds.map((eventId) => ({ eventId, projectId: id!, relation: projectId ? "change" : "new" })))
      .onConflictDoNothing();
    await db
      .update(schema.events)
      .set({ status: "sorted", updatedAt: new Date() })
      .where(inArray(schema.events.id, eventIds));
  }
  return id;
}

/** Merge people lists, matching on email, Slack id, then name; later values fill gaps. */
export function mergePeople(current: Person[], incoming: Person[]): Person[] {
  const out = current.map((p) => ({ ...p }));
  for (const person of incoming) {
    const match = out.find(
      (p) =>
        (person.email && p.email?.toLowerCase() === person.email.toLowerCase()) ||
        (person.slackUserId && p.slackUserId === person.slackUserId) ||
        p.name.toLowerCase() === person.name.toLowerCase(),
    );
    if (match) {
      match.email ??= person.email;
      match.slackUserId ??= person.slackUserId;
      match.role ??= person.role;
    } else {
      out.push({ ...person });
    }
  }
  return out;
}

type RequirementRow = typeof schema.requirements.$inferSelect;

async function applyRequirementChanges(
  projectId: string,
  plan: Plan,
  source: { proposalId: string; eventIds: string[] },
): Promise<Map<string, RequirementRow>> {
  const existing = await db.query.requirements.findMany({
    where: eq(schema.requirements.projectId, projectId),
  });
  const byRef = new Map<string, RequirementRow>(existing.map((r) => [r.id, r]));

  for (const change of plan.requirementChanges) {
    const current = byRef.get(change.ref);
    if (change.op === "create" || !current) {
      const [row] = await db
        .insert(schema.requirements)
        .values({
          projectId,
          title: change.title,
          description: change.description,
          status: change.status,
          approvedBy: change.approvedBy,
        })
        .returning();
      await recordVersion(row, { ...source, reason: change.reason });
      byRef.set(change.ref, row);
      byRef.set(row.id, row);
    } else {
      const [row] = await db
        .update(schema.requirements)
        .set({
          title: change.title,
          description: change.description,
          status: change.op === "drop" ? "dropped" : change.status,
          approvedBy: change.approvedBy ?? current.approvedBy,
          updatedAt: new Date(),
        })
        .where(eq(schema.requirements.id, current.id))
        .returning();
      await recordVersion(row, { ...source, reason: change.reason }, current);
      byRef.set(change.ref, row);
      byRef.set(row.id, row);
    }
  }
  return byRef;
}

async function runAction(
  action: Action,
  refs: Map<string, RequirementRow>,
  senders: Senders,
): Promise<Record<string, unknown>> {
  switch (action.type) {
    case "jira_create": {
      const jira = need(senders.jira, "Jira");
      const issue = await jira.createIssue({
        summary: action.summary,
        description: withExtraDetails(action.description, action.details),
        ...(await jiraTypeFor(action)),
        parentKey: action.kind === "epic" ? null : epicKeyFor(action.epicRef ?? null, refs),
      });
      const req = refs.get(action.requirementRef);
      if (req) {
        const [row] = await db
          .update(schema.requirements)
          .set({ jiraIssueKey: issue.key, updatedAt: new Date() })
          .where(eq(schema.requirements.id, req.id))
          .returning();
        refs.set(action.requirementRef, row);
        refs.set(row.id, row);
      }
      await recordIsaWrite(issue.key, req?.projectId ?? null);
      const warnings = action.details ? await applyDetails(jira, issue.key, action.details) : [];
      return warnings.length ? { ...issue, warnings } : issue;
    }
    case "jira_update": {
      const jira = need(senders.jira, "Jira");
      const key = issueKeyFor(action.issueKey, action.requirementRef, refs);
      await recordIsaWrite(key);
      await jira.updateIssue(key, action);
      return { key, url: jira.issueUrl(key) };
    }
    case "jira_comment": {
      const jira = need(senders.jira, "Jira");
      const key = issueKeyFor(action.issueKey, action.requirementRef, refs);
      await recordIsaWrite(key);
      await jira.addComment(key, action.body);
      return { key, url: jira.issueUrl(key) };
    }
    case "jira_close": {
      const jira = need(senders.jira, "Jira");
      const key = issueKeyFor(action.issueKey, action.requirementRef, refs);
      await recordIsaWrite(key);
      await jira.addComment(key, action.reason);
      const status = await jira.closeIssue(key);
      return { key, url: jira.issueUrl(key), status };
    }
    case "slack_message": {
      const slack = need(senders.slack, "Slack");
      return slack.postMessage(action.channel, action.text, action.threadTs);
    }
    case "email": {
      const email = need(senders.email, "Gmail");
      return email.send(action);
    }
  }
}

function issueKeyFor(explicit: string | null, ref: string, refs: Map<string, RequirementRow>): string {
  const key = explicit ?? refs.get(ref)?.jiraIssueKey;
  if (!key) throw new Error(`No Jira ticket is linked to requirement "${refs.get(ref)?.title ?? ref}"`);
  return key;
}

function need<T>(sender: T | null, name: string): T {
  if (!sender) throw new Error(`${name} is not connected`);
  return sender;
}

/** The epic a new ticket goes under: a Jira key as given, or the key of an epic created earlier in the plan. */
function epicKeyFor(epicRef: string | null, refs: Map<string, RequirementRow>): string | null {
  if (!epicRef) return null;
  if (/^[A-Z][A-Z0-9_]+-\d+$/.test(epicRef)) return epicRef;
  const key = refs.get(epicRef)?.jiraIssueKey;
  if (!key) throw new Error(`The epic "${refs.get(epicRef)?.title ?? epicRef}" has no Jira ticket yet, so this ticket cannot go under it`);
  return key;
}

/** The Jira issue type and label for a ticket kind, from the owner's ticket formats. */
/** The owner's own fields go into the ticket's description, since Jira has no field for them. */
export function withExtraDetails(description: string, details: TicketDetails | null | undefined): string {
  const extra = (details?.extra ?? []).filter((e) => e.name.trim() && e.value.trim());
  if (!extra.length) return description;
  return `${description}\n\nDetails\n${extra.map((e) => `- ${e.name.trim()}: ${e.value.trim()}`).join("\n")}`;
}

/**
 * Set the confirmed sprint, story points and links on a ticket just created. The ticket exists
 * either way, so a detail Jira refuses becomes a note for the owner instead of a failed step.
 */
async function applyDetails(jira: JiraClient, key: string, d: TicketDetails): Promise<string[]> {
  const warnings: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error("jira detail failed", { what, error: err instanceof Error ? err.name : "unknown" });
      warnings.push(`${key}: could not set ${what} (${err instanceof Error ? err.message.slice(0, 160) : "error"})`);
    }
  };
  if (d.sprint?.trim()) {
    await attempt(`sprint "${d.sprint}"`, async () => {
      const sprint = (await jira.openSprints()).find((s) => s.name.trim().toLowerCase() === d.sprint!.trim().toLowerCase());
      if (!sprint) throw new Error("no open sprint has that name");
      await jira.moveToSprint(key, sprint.id);
    });
  }
  if (d.storyPoints != null && Number.isFinite(d.storyPoints)) {
    await attempt(`story points ${d.storyPoints}`, () => jira.setStoryPoints(key, d.storyPoints!));
  }
  for (const other of d.links.filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k) && k !== key)) {
    await attempt(`a link to ${other}`, () => jira.linkIssues(key, other));
  }
  return warnings;
}

async function jiraTypeFor(action: Extract<Action, { type: "jira_create" }>): Promise<{ issueType: string; labels: string[] }> {
  // The owner's answer to a missing-type question wins.
  const chosen = (action as { jiraIssueType?: string }).jiraIssueType;
  if (chosen) return { issueType: chosen, labels: await labelsFor(action) };
  // Proposals drafted before ticket kinds existed carry a Jira issue type instead.
  const legacy = (action as { issueType?: string }).issueType;
  if (!action.kind && legacy) return { issueType: legacy, labels: [] };
  const format = (await ticketFormats()).find((f) => f.kind === (action.kind as TicketKind));
  return { issueType: format?.jiraIssueType ?? "Task", labels: format?.label ? [format.label] : [] };
}

async function labelsFor(action: Extract<Action, { type: "jira_create" }>): Promise<string[]> {
  const format = (await ticketFormats()).find((f) => f.kind === action.kind);
  return format?.label ? [format.label] : [];
}

export type ActionQuestion = { kind: "missing_issue_type"; projectKey: string; wanted: string; available: string[] };

/**
 * The owner answered "Jira has no ticket type X": create those tickets as `choice` (or skip them),
 * optionally remember it in the ticket format, then run the proposal's failed actions again.
 */
export async function answerMissingIssueType(
  proposalId: string,
  wanted: string,
  choice: { useType: string } | { skip: true },
  remember: boolean,
  senders: Senders,
): Promise<ExecutionResult> {
  const failed = await db
    .select()
    .from(schema.actions)
    .where(and(eq(schema.actions.proposalId, proposalId), eq(schema.actions.status, "failed")));
  const affected = failed.filter((a) => (a.result as { question?: ActionQuestion } | null)?.question?.wanted === wanted);
  if (!affected.length) throw new Error("Nothing to answer");

  for (const a of affected) {
    if ("skip" in choice) {
      await db
        .update(schema.actions)
        .set({ status: "skipped", error: null, result: null, updatedAt: new Date() })
        .where(eq(schema.actions.id, a.id));
    } else {
      await db
        .update(schema.actions)
        .set({ payload: { ...(a.payload as object), jiraIssueType: choice.useType }, updatedAt: new Date() })
        .where(eq(schema.actions.id, a.id));
    }
  }

  if (remember && "useType" in choice) {
    const kinds = new Set(affected.map((a) => (a.payload as { kind?: TicketKind }).kind).filter((k) => k !== undefined));
    const formats = await ticketFormats();
    for (const kind of kinds) {
      const f = formats.find((x) => x.kind === kind);
      if (f) await saveTicketFormat({ ...f, jiraIssueType: choice.useType });
    }
  }
  return retryFailedActions(proposalId, senders);
}
