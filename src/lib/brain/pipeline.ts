import { and, asc, desc, eq, gte, inArray, like, lte, ne } from "drizzle-orm";
import { syncJira, type JiraReader } from "@/lib/jira-sync";
import { db, schema } from "@/db";
import { DraftSchema, DraftWithDetailsSchema, SortDraftSchema, fromDraft, fromSortDraft, type Plan, type SortResult } from "@/lib/plan";
import { eventText, projectBlock, projectsContext } from "./context";
import { PROPOSE_SYSTEM, SORT_SYSTEM } from "./prompts";
import type { StructuredLLM } from "./llm";
import { formatsText, ticketFormats } from "@/lib/ticket-formats";
import { openSprintNames, relatedTicketsBlock } from "@/lib/jira-research";
import { jiraKeyFor, jiraProjectsText } from "@/lib/jira-project";
import { asksDetails, getSettings, settingsText } from "@/lib/settings";
import { keepToProject, owners } from "@/lib/ownership";
import { saveCommitments } from "@/lib/reminders";
import { savePersonNotes } from "@/lib/people";
import { recordMemory } from "@/lib/executor";
import { saveCardVersion } from "@/lib/card-versions";
import { sourceOf } from "@/lib/sources";
import { log } from "@/lib/log";

/** Ask Claude for a draft plan, with ticket details only when the owner's settings ask for them. */
async function draft(llm: StructuredLLM, req: { system: string; context: string; input: string; effort: "low" | "medium" | "high" }): Promise<Plan> {
  const withDetails = asksDetails(await getSettings());
  const out = withDetails ? await llm({ ...req, schema: DraftWithDetailsSchema }) : await llm({ ...req, schema: DraftSchema });
  return fromDraft(out);
}

/** Who the owner is, so ISA can tell which promises in an item are theirs. */
async function ownerLine(): Promise<string> {
  const { ownerName } = await getSettings();
  return ownerName ? `The owner is ${ownerName}.\n\n` : "";
}

/** Context for drafting: the owner's ticket formats, then the project. */
async function withFormats(context: string, terms: string[] = [], projectId: string | null = null): Promise<string> {
  const [related, settings] = await Promise.all([relatedTicketsBlock(terms, projectId), getSettings()]);
  const jiraKey = await jiraKeyFor(projectId);
  const sprints = settings.askSprint ? await openSprintNames(jiraKey) : [];
  const keyText = await jiraProjectsText(projectId);
  const sprintText = settings.askSprint ? `Open sprints in Jira project ${jiraKey ?? "?"}: ${sprints.length ? sprints.map((n) => `"${n}"`).join(", ") : "none found"}` : "";
  return [formatsText(await ticketFormats()), settingsText(settings), keyText, sprintText, context, related].filter(Boolean).join("\n\n");
}

/** What to search Jira for: the terms ISA picked when it sorted these items. */
function termsOf(events: EventRow[]): string[] {
  return [...new Set(events.flatMap((e) => e.sortResult?.searchTerms ?? []))].slice(0, 5);
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
  const ctx = { eventId, source: event.source };
  const started = Date.now();
  log.info("event processing started", ctx);

  try {
    const { text: context, projectIds } = await projectsContext();
    const raw = await llm({
      system: SORT_SYSTEM,
      context,
      input: `${await ownerLine()}${await conversationSoFar(event)}New item:\n${eventText(event)}`,
      schema: SortDraftSchema,
      effort: "medium",
    }).then(fromSortDraft);
    const sort = cleanSort(raw, projectIds);
    const terms = sort.searchTerms ?? [];
    // Like a secretary: what the item asks of the owner becomes a reminder (internal only).
    await saveCommitments(event.id, sort.commitments ?? [], projectIds);
    await savePersonNotes(event.id, sort.peopleNotes ?? [], projectIds);

    const proposalIds: string[] = [];
    let unsure = false;

    for (const match of sort.matches) {
      if (match.confidence === "high") {
        await linkEvent(event.id, match.projectId, match.relation, match.note);
        if (match.relation !== "context") {
          const others = sort.matches.filter((m) => m.projectId !== match.projectId);
          const id = await proposeUpdate(match.projectId, [event], llm, terms, focusText(match.note, others.map((m) => m.note)));
          if (id) proposalIds.push(id);
        }
      } else if (!unsure) {
        // One question per item: the card offers every project, with ISA's best guess first.
        unsure = true;
        const rank = { high: 0, medium: 1, low: 2 } as const;
        const best = sort.matches.filter((m) => m.confidence !== "high").sort((a, b) => rank[a.confidence] - rank[b.confidence])[0];
        proposalIds.push(await askWhichProject(event, best.projectId, best.note));
      }
    }

    if (sort.newProject) {
      proposalIds.push(await proposeNewProject(event, sort.newProject.name, llm, terms));
    }

    const status = sort.ignore && proposalIds.length === 0 && sort.matches.length === 0 ? "ignored" : unsure ? "unsure" : "sorted";
    await db
      .update(schema.events)
      .set({ status, sortResult: sort, error: null, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));

    log.info("event processed", {
      ...ctx,
      status,
      matches: sort.matches.length,
      proposals: proposalIds.length,
      newProject: !!sort.newProject,
      commitments: sort.commitments?.length ?? 0,
      ms: Date.now() - started,
    });
    if (status === "ignored") return { kind: "ignored" };
    return { kind: unsure ? "unsure" : "filed", proposalIds };
  } catch (err) {
    log.error("event processing failed", err, { ...ctx, ms: Date.now() - started });
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.events)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(schema.events.id, event.id));
    throw err;
  }
}

/**
 * Where earlier items of the same conversation (a Slack DM, channel or thread, or an email
 * thread) were filed in the last day, so a short reply can follow the message it answers.
 */
async function conversationSoFar(event: EventRow): Promise<string> {
  const prefix = event.source === "slack" ? `${event.externalId.split(":")[0]}:` : null;
  if (!prefix) return "";
  const since = new Date(event.occurredAt.getTime() - 24 * 3600_000);
  const rows = await db
    .select({ title: schema.events.title, at: schema.events.occurredAt, project: schema.projects.name, note: schema.eventProjects.note })
    .from(schema.events)
    .innerJoin(schema.eventProjects, eq(schema.eventProjects.eventId, schema.events.id))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.eventProjects.projectId))
    .where(
      and(
        eq(schema.events.source, event.source),
        like(schema.events.externalId, `${prefix.replace(/[%_]/g, "")}%`),
        ne(schema.events.id, event.id),
        gte(schema.events.occurredAt, since),
        lte(schema.events.occurredAt, event.occurredAt),
      ),
    )
    .orderBy(desc(schema.events.occurredAt))
    .limit(8);
  if (!rows.length) return "";
  return `Earlier items from this same conversation were filed to:\n${rows.map((r) => `- ${r.project}: ${r.note || r.title}`).join("\n")}\n\n`;
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

/**
 * What part of an item a project's draft should use. A meeting or email can cover several
 * projects; each project's draft must ignore the parts that belong to the others.
 */
export function focusText(note: string, otherNotes: string[] = []): string {
  return [
    `Draft only for this project. What in these items concerns it: ${note}`,
    otherNotes.length
      ? `Other parts of the same items concern other projects and are drafted there; ignore them completely:\n${otherNotes.map((n) => `- ${n}`).join("\n")}`
      : "If parts of the items are about other work, ignore them.",
    "Never update, comment on or close a ticket that is not this project's.",
  ].join("\n");
}

/** Keep the draft to this project, dropping steps on other projects' tickets. */
async function ownPlan(plan: Plan, projectId: string): Promise<Plan> {
  return keepToProject(plan, projectId, await owners()).plan;
}

/** Draft an update for an existing project from new events. Returns null when nothing changes. */
export async function proposeUpdate(
  projectId: string,
  events: EventRow[],
  llm: StructuredLLM,
  terms: string[] = termsOf(events),
  focus: string = focusText("the parts about this project's work"),
): Promise<string | null> {
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project) throw new Error("Project not found");

  // A suggestion for this project is still waiting for the owner: fold the new items into it,
  // so the owner sees one up-to-date card per project instead of overlapping ones.
  const waiting = await db.query.proposals.findFirst({
    where: and(
      eq(schema.proposals.projectId, projectId),
      eq(schema.proposals.status, "pending"),
      inArray(schema.proposals.kind, ["update", "new_project"]),
    ),
    orderBy: desc(schema.proposals.createdAt),
  });
  if (waiting) {
    const id = await mergeIntoWaiting(waiting, projectId, events, llm, terms, focus);
    await recordMemory(id);
    return id;
  }

  const plan = await draft(llm, {
    system: PROPOSE_SYSTEM,
    context: await withFormats(`The project:\n${await projectBlock(projectId)}`, terms, projectId),
    input: `New items:\n${events.map(eventText).join("\n\n")}\n\n${focus}`,
    effort: "high",
  });
  const cleaned = await ownPlan(cleanPlan({ ...plan, projectName: null }), projectId);
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
  // Memory first: the project knows what was decided now; Jira and messages stay optional.
  await recordMemory(row.id);
  return row.id;
}

/** Why new items changed a card, naming each item's source and author (e.g. "Slack message from Ana"). */
function newItemsReason(events: EventRow[]): string {
  const one = (e: EventRow) => `${sourceOf(e.source).label}${e.author ? ` from ${e.author.replace(/\s*<.*>$/, "")}` : ""}`;
  const names = [...new Set(events.map(one))];
  return `New info arrived: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}.`;
}

/** Redraft a waiting suggestion with new items, keeping one card per project. */
async function mergeIntoWaiting(
  waiting: typeof schema.proposals.$inferSelect,
  projectId: string,
  events: EventRow[],
  llm: StructuredLLM,
  terms: string[],
  focus: string,
): Promise<string> {
  const fresh = events.filter((e) => !waiting.eventIds.includes(e.id));
  if (!fresh.length) return waiting.id;
  const earlier = waiting.eventIds.length
    ? await db.query.events.findMany({ where: inArray(schema.events.id, waiting.eventIds), orderBy: asc(schema.events.occurredAt) })
    : [];
  const plan = await draft(llm, {
    system: PROPOSE_SYSTEM,
    context: await withFormats(`The project:\n${await projectBlock(projectId)}`, terms, projectId),
    input: [
      `Items you already drafted from:\n${earlier.map(eventText).join("\n\n") || "(none)"}`,
      `Your draft, still waiting for the owner's approval (nothing in it exists in Jira yet):\n${JSON.stringify(waiting.plan, null, 2)}`,
      `New items:\n${fresh.map(eventText).join("\n\n")}`,
      "Return the whole updated draft with the new items merged in. Keep one epic and one ticket per piece of work: extend or correct what the draft already has instead of adding duplicates. Drop open questions the new items answer. Start the summary with what the new items changed.",
      focus,
    ].join("\n\n"),
    effort: "high",
  });
  const cleaned = await ownPlan(
    cleanPlan(waiting.kind === "new_project" ? { ...plan, projectName: plan.projectName || waiting.plan.projectName } : { ...plan, projectName: null }),
    projectId,
  );
  await saveCardVersion(
    waiting.id,
    waiting.plan,
    cleaned,
    { cause: "new_items", reason: newItemsReason(fresh), eventIds: fresh.map((e) => e.id) },
    { eventIds: [...waiting.eventIds, ...fresh.map((e) => e.id)] },
  );
  return waiting.id;
}

/**
 * Work that fits no project: create the project right away and file the item under it, so its
 * transcript and history are there at once. The drafted tickets still wait for approval.
 */
async function proposeNewProject(event: EventRow, name: string, llm: StructuredLLM, terms: string[] = termsOf([event])): Promise<string> {
  const [project] = await db
    .insert(schema.projects)
    .values({ name, jiraProjectKey: null })
    .returning({ id: schema.projects.id });
  await linkEvent(event.id, project.id, "new", "Started this project");
  const plan = await draft(llm, {
    system: PROPOSE_SYSTEM,
    context: await withFormats(`This is a new project. Suggested name: ${name}`, terms),
    input: `New items:\n${eventText(event)}`,
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
  await recordMemory(row.id);
  return row.id;
}

/** "Is this about project X?" Approving it files the event there and drafts the update. */
async function askWhichProject(event: EventRow, projectId: string, note: string): Promise<string> {
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
      title: `Where does "${event.title}" belong?`,
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
  const plan = await draft(llm, {
    system: PROPOSE_SYSTEM,
    context: await withFormats(
      proposal.projectId
        ? `The project:\n${await projectBlock(proposal.projectId)}`
        : `This is a new project. Suggested name: ${proposal.plan.projectName ?? ""}`,
      termsOf(events),
      proposal.projectId,
    ),
    input: [
      `New items:\n${events.map(eventText).join("\n\n") || "(none)"}`,
      `Your current draft plan:\n${JSON.stringify(proposal.plan, null, 2)}`,
      `The owner's correction, which wins over the items:\n${instruction}`,
      "Return the whole corrected plan.",
    ].join("\n\n"),
    effort: "high",
  });
  const cleaned = cleanPlan(
    proposal.kind === "new_project" ? { ...plan, projectName: plan.projectName || proposal.plan.projectName } : { ...plan, projectName: null },
  );
  await saveCardVersion(
    proposalId,
    proposal.plan,
    cleaned,
    { cause: "correction", reason: `You asked ISA: "${instruction.trim().slice(0, 300)}"` },
    { title: proposal.kind === "new_project" ? `New project: ${cleaned.projectName}` : proposal.title },
  );
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
 * File an item under one more project, keeping its other projects: for a meeting or email that
 * covered several topics. Drafts only the part about that project.
 */
export async function alsoFileEvent(eventId: string, projectId: string, about: string, llm: StructuredLLM): Promise<string | null> {
  const event = await db.query.events.findFirst({ where: eq(schema.events.id, eventId) });
  if (!event) throw new Error("Item not found");
  const others = await db.select({ note: schema.eventProjects.note, projectId: schema.eventProjects.projectId }).from(schema.eventProjects).where(eq(schema.eventProjects.eventId, eventId));
  await linkEvent(eventId, projectId, "change", about);
  const otherNotes = others.filter((o) => o.projectId !== projectId).map((o) => o.note ?? "").filter(Boolean);
  return proposeUpdate(projectId, [event], llm, termsOf([event]), focusText(about, otherNotes));
}

/**
 * Draft a fresh proposal from an item already filed under a project, e.g. after its tickets were
 * deleted in Jira. Tickets that no longer exist are unlinked first, so ISA proposes them again.
 */
export async function redraftFromEvent(
  eventId: string,
  projectId: string,
  llm: StructuredLLM,
  jira: JiraReader | null,
): Promise<string | null> {
  const event = await db.query.events.findFirst({ where: eq(schema.events.id, eventId) });
  if (!event) throw new Error("Item not found");
  if (jira) await syncJira(jira, projectId);
  return proposeUpdate(projectId, [event], llm);
}

/** Draft the project's tickets again from its latest items, after checking Jira. */
export async function redraftProject(projectId: string, llm: StructuredLLM, jira: JiraReader | null): Promise<string | null> {
  if (jira) await syncJira(jira, projectId);
  const links = await db.select().from(schema.eventProjects).where(eq(schema.eventProjects.projectId, projectId));
  if (!links.length) throw new Error("Nothing is filed under this project yet");
  const events = await db.query.events.findMany({
    where: inArray(schema.events.id, links.map((l) => l.eventId)),
    orderBy: desc(schema.events.occurredAt),
    limit: 5,
  });
  return proposeUpdate(projectId, events.reverse(), llm);
}

/**
 * The owner answered "where does this go?": file the item under the chosen project (or a new
 * one) and draft its tickets there. Returns the new suggestion's id, if any.
 */
export async function placeClarification(
  proposalId: string,
  target: { projectId: string } | { newProjectName: string },
  llm: StructuredLLM,
): Promise<string | null> {
  const proposal = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  if (!proposal || proposal.kind !== "clarify" || proposal.status !== "pending") throw new Error("Nothing to place");
  await db
    .update(schema.proposals)
    .set({ status: "executed", decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.proposals.id, proposalId));
  let last: string | null = null;
  for (const eventId of proposal.eventIds) last = (await refileEvent(eventId, target, llm)) ?? last;
  return last;
}
