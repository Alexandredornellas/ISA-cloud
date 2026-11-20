import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { PlanSchema, SortResultSchema, type Plan, type SortResult } from "@/lib/plan";
import { eventText, projectBlock, projectsContext } from "./context";
import { PROPOSE_SYSTEM, SORT_SYSTEM } from "./prompts";
import type { StructuredLLM } from "./llm";
import { formatsText, ticketFormats } from "@/lib/ticket-formats";

/** Context for drafting: the owner's ticket formats, then the project. */
async function withFormats(context: string): Promise<string> {
  return `${formatsText(await ticketFormats())}\n\n${context}`;
}

type EventRow = typeof schema.events.$inferSelect;

export type ProcessOutcome =
  | { kind: "ignored" }
  | { kind: "filed"; proposalIds: string[] }
  | { kind: "unsure"; proposalIds: string[] };

/**
 * Sort one new event and create the proposals it leads to:
 * - a clear match to a project files the event there and drafts that project's update;
 * - an unclear match asks the owner "Is this about project X?";
 * - work that fits no project drafts a new project.
 */
export async function processEvent(eventId: string, llm: StructuredLLM): Promise<ProcessOutcome> {
  const event = await db.query.events.findFirst({ where: eq(schema.events.id, eventId) });
  if (!event) throw new Error("Event not found");

  try {
    const { text: context, projectIds } = await projectsContext();
    const raw = await llm({
      system: SORT_SYSTEM,
      context,
      input: `New item:\n${eventText(event)}`,
      schema: SortResultSchema,
      effort: "medium",
    });
    const sort = cleanSort(raw, projectIds);

    const proposalIds: string[] = [];
    let unsure = false;

    for (const match of sort.matches) {
      if (match.confidence === "high") {
        await linkEvent(event.id, match.projectId, match.relation, match.note);
        if (match.relation !== "context") {
          const id = await proposeUpdate(match.projectId, [event], llm);
          if (id) proposalIds.push(id);
        }
      } else {
        unsure = true;
        proposalIds.push(await askWhichProject(event, match.projectId, match.note));
      }
    }

    if (sort.newProject) {
      proposalIds.push(await proposeNewProject(event, sort.newProject.name, llm));
    }

    const status = sort.ignore && proposalIds.length === 0 && sort.matches.length === 0 ? "ignored" : unsure ? "unsure" : "sorted";
    await db
      .update(schema.events)
      .set({ status, sortResult: sort, error: null, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));

    if (status === "ignored") return { kind: "ignored" };
    return { kind: unsure ? "unsure" : "filed", proposalIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.events)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));
    throw err;
  }
}

/** Drop matches to projects that do not exist, and repeated matches to the same project. */
export function cleanSort(sort: SortResult, projectIds: Set<string>): SortResult {
  const seen = new Set<string>();
  const matches = sort.matches.filter((m) => {
    if (!projectIds.has(m.projectId) || seen.has(m.projectId)) return false;
    seen.add(m.projectId);
    return true;
  });
  return { ...sort, matches };
}

async function linkEvent(eventId: string, projectId: string, relation: string, note: string) {
  await db
    .insert(schema.eventProjects)
    .values({ eventId, projectId, relation, note })
    .onConflictDoUpdate({
      target: [schema.eventProjects.eventId, schema.eventProjects.projectId],
      set: { relation, note },
    });
}

/** Draft an update for an existing project from new events. Returns null when nothing changes. */
export async function proposeUpdate(projectId: string, events: EventRow[], llm: StructuredLLM): Promise<string | null> {
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project) throw new Error("Project not found");
  const plan = await llm({
    system: PROPOSE_SYSTEM,
    context: await withFormats(`The project:\n${await projectBlock(projectId)}`),
    input: `New items:\n${events.map(eventText).join("\n\n")}`,
    schema: PlanSchema,
    effort: "high",
  });
  const cleaned = cleanPlan({ ...plan, projectName: null });
  if (cleaned.requirementChanges.length === 0 && cleaned.actions.length === 0) return null;
  const [row] = await db
    .insert(schema.proposals)
    .values({
      kind: "update",
      projectId,
      title: `Changes on ${project.name}`,
      plan: cleaned,
      eventIds: events.map((e) => e.id),
    })
    .returning({ id: schema.proposals.id });
  return row.id;
}

/**
 * Work that fits no project: create the project right away and file the item under it, so its
 * transcript and history are there at once. The drafted tickets still wait for approval.
 */
async function proposeNewProject(event: EventRow, name: string, llm: StructuredLLM): Promise<string> {
  const [project] = await db
    .insert(schema.projects)
    .values({ name, jiraProjectKey: process.env.JIRA_PROJECT_KEY ?? null })
    .returning({ id: schema.projects.id });
  await linkEvent(event.id, project.id, "new", "Started this project");
  const plan = await llm({
    system: PROPOSE_SYSTEM,
    context: await withFormats(`This is a new project. Suggested name: ${name}`),
    input: `New items:\n${eventText(event)}`,
    schema: PlanSchema,
    effort: "high",
  });
  const cleaned = cleanPlan({ ...plan, projectName: plan.projectName || name });
  await db
    .update(schema.projects)
    .set({ name: cleaned.projectName!, summary: cleaned.summary, updatedAt: new Date() })
    .where(eq(schema.projects.id, project.id));
  const [row] = await db
    .insert(schema.proposals)
    .values({
      kind: "new_project",
      projectId: project.id,
      title: `New project: ${cleaned.projectName}`,
      plan: cleaned,
      eventIds: [event.id],
    })
    .returning({ id: schema.proposals.id });
  return row.id;
}

/** "Is this about project X?" Approving it files the event there and drafts the update. */
async function askWhichProject(event: EventRow, projectId: string, note: string): Promise<string> {
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  const plan: Plan = {
    summary: note,
    projectName: null,
    people: [],
    requirementChanges: [],
    actions: [],
    openQuestions: [],
  };
  const [row] = await db
    .insert(schema.proposals)
    .values({
      kind: "clarify",
      projectId,
      title: `Is "${event.title}" about ${project?.name ?? "this project"}?`,
      plan,
      eventIds: [event.id],
    })
    .returning({ id: schema.proposals.id });
  return row.id;
}

/** The owner confirmed a "which project" question: file the event and draft the update. */
export async function confirmClarification(proposalId: string, llm: StructuredLLM): Promise<string | null> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || proposal.kind !== "clarify" || proposal.status !== "pending" || !proposal.projectId) {
    throw new Error("Nothing to confirm");
  }
  await db
    .update(schema.proposals)
    .set({ status: "executed", decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.proposals.id, proposalId));
  const events = await db.query.events.findMany({ where: inArray(schema.events.id, proposal.eventIds) });
  for (const e of events) await linkEvent(e.id, proposal.projectId, "change", proposal.plan.summary);
  await db
    .update(schema.events)
    .set({ status: "sorted", updatedAt: new Date() })
    .where(inArray(schema.events.id, proposal.eventIds));
  return proposeUpdate(proposal.projectId, events, llm);
}

/** Drop actions that cannot be carried out. */
export function cleanPlan(plan: Plan): Plan {
  const actions = plan.actions.filter((a) => {
    if (a.type === "slack_message") return a.channel.trim() !== "" && a.text.trim() !== "";
    if (a.type === "email") return a.to.length > 0 && a.body.trim() !== "";
    return true;
  });
  return { ...plan, actions };
}

/** Redraft a pending proposal with the owner's correction, keeping the same proposal. */
export async function reviseProposal(proposalId: string, instruction: string, llm: StructuredLLM): Promise<Plan> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || proposal.status !== "pending" || proposal.kind === "clarify") {
    throw new Error("Only a pending proposal with changes can be revised");
  }
  const events = proposal.eventIds.length
    ? await db.query.events.findMany({ where: inArray(schema.events.id, proposal.eventIds) })
    : [];
  const plan = await llm({
    system: PROPOSE_SYSTEM,
    context: await withFormats(
      proposal.projectId
        ? `The project:\n${await projectBlock(proposal.projectId)}`
        : `This is a new project. Suggested name: ${proposal.plan.projectName ?? ""}`,
    ),
    input: [
      `New items:\n${events.map(eventText).join("\n\n") || "(none)"}`,
      `Your current draft plan:\n${JSON.stringify(proposal.plan, null, 2)}`,
      `The owner's correction, which wins over the items:\n${instruction}`,
      "Return the whole corrected plan.",
    ].join("\n\n"),
    schema: PlanSchema,
    effort: "high",
  });
  const cleaned = cleanPlan(
    proposal.kind === "new_project" ? { ...plan, projectName: plan.projectName || proposal.plan.projectName } : { ...plan, projectName: null },
  );
  await db
    .update(schema.proposals)
    .set({
      plan: cleaned,
      title: proposal.kind === "new_project" ? `New project: ${cleaned.projectName}` : proposal.title,
      updatedAt: new Date(),
    })
    .where(eq(schema.proposals.id, proposalId));
  return cleaned;
}

/**
 * File an item under a different project (or a new one): pending proposals drafted from it are
 * dismissed, and a fresh one is drafted for the target. Returns the new proposal id, if any.
 */
export async function refileEvent(
  eventId: string,
  target: { projectId: string } | { newProjectName: string },
  llm: StructuredLLM,
): Promise<string | null> {
  const event = await db.query.events.findFirst({ where: eq(schema.events.id, eventId) });
  if (!event) throw new Error("Item not found");
  const pending = await db.query.proposals.findMany({ where: eq(schema.proposals.status, "pending") });
  const stale = pending.filter((p) => p.eventIds.includes(eventId)).map((p) => p.id);
  if (stale.length) {
    await db
      .update(schema.proposals)
      .set({ status: "dismissed", decidedAt: new Date(), updatedAt: new Date() })
      .where(inArray(schema.proposals.id, stale));
  }
  await db.delete(schema.eventProjects).where(eq(schema.eventProjects.eventId, eventId));
  await db.update(schema.events).set({ status: "sorted", updatedAt: new Date() }).where(eq(schema.events.id, eventId));
  if ("projectId" in target) {
    await linkEvent(eventId, target.projectId, "change", "Filed here by the owner");
    return proposeUpdate(target.projectId, [event], llm);
  }
  return proposeNewProject(event, target.newProjectName, llm);
}

/**
 * Draft a fresh proposal from an item already filed under a project, e.g. after its tickets were
 * deleted in Jira. Tickets that no longer exist are unlinked first, so ISA proposes them again.
 */
export async function redraftFromEvent(
  eventId: string,
  projectId: string,
  llm: StructuredLLM,
  jira: { issueExists(key: string): Promise<boolean> } | null,
): Promise<string | null> {
  const event = await db.query.events.findFirst({ where: eq(schema.events.id, eventId) });
  if (!event) throw new Error("Item not found");
  if (jira) {
    const reqs = await db.query.requirements.findMany({ where: eq(schema.requirements.projectId, projectId) });
    for (const r of reqs) {
      if (r.jiraIssueKey && !(await jira.issueExists(r.jiraIssueKey))) {
        await db
          .update(schema.requirements)
          .set({ jiraIssueKey: null, updatedAt: new Date() })
          .where(eq(schema.requirements.id, r.id));
      }
    }
  }
  return proposeUpdate(projectId, [event], llm);
}
