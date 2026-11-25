// ISA's home screen: one channel per project plus General. Suggestions that wait on the owner
// show as "Needs you" cards in their channel until the owner acts on them.
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { missingTypeQuestions, type MissingTypeQuestion } from "@/lib/queries";
import type { Plan } from "@/lib/plan";
import { cardVersions, versionChanges } from "@/lib/card-versions";
import { getSettings, type Settings } from "@/lib/settings";
import { openSprintNames } from "@/lib/jira-research";
import { jiraKeyFor, jiraProjectChoices, type JiraProjectChoice } from "@/lib/jira-project";
import { jiraSearcher } from "@/lib/jira-research";
import type { JiraClient } from "@/lib/jira";
import { log } from "@/lib/log";

export type Channel = { id: string | null; name: string; count: number; done: boolean };

type ProposalRow = typeof schema.proposals.$inferSelect;

/** Waiting on the owner: drafts to review and approved suggestions that failed. */
const WAITING = ["pending", "failed"] as const;

/** Which channel a suggestion belongs to: a "where does this go?" question and an unfiled draft go to General. */
export function channelOf(p: Pick<ProposalRow, "kind" | "projectId">): string | null {
  return p.kind === "clarify" ? null : p.projectId;
}

export async function channels(): Promise<Channel[]> {
  const [projects, reqs, waiting] = await Promise.all([
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
    db.select({ projectId: schema.requirements.projectId, status: schema.requirements.status }).from(schema.requirements),
    db.select({ kind: schema.proposals.kind, projectId: schema.proposals.projectId }).from(schema.proposals).where(inArray(schema.proposals.status, [...WAITING])),
  ]);
  const count = (id: string | null) => waiting.filter((p) => channelOf(p) === id).length;
  return [
    { id: null, name: "General", count: count(null), done: false },
    ...projects.map((p) => {
      const mine = reqs.filter((r) => r.projectId === p.id);
      const open = mine.some((r) => r.status !== "done" && r.status !== "dropped");
      const n = count(p.id);
      return { id: p.id, name: p.name, count: n, done: mine.length > 0 && !open && n === 0 };
    }),
  ];
}

export type Notification = {
  id: string;
  kind: ProposalRow["kind"];
  status: ProposalRow["status"];
  title: string;
  plan: Plan;
  error: string | null;
  createdAt: Date;
  sources: { id: string; source: string; title: string; url: string | null; author: string | null; at: Date }[];
  /** For a suggestion that creates an epic: the project's existing epics to choose from instead. */
  existingEpics: { key: string; label: string }[];
  /** For a "where does this go?" question: where it could go, ISA's guess first. */
  places: { projectId: string; name: string; best: boolean }[];
  question: MissingTypeQuestion | null;
  /** The details the owner's settings say to confirm on each new ticket. */
  asks: Settings;
  /** Open sprints to choose from, when the owner confirms sprints. */
  sprints: string[];
  /** Requirement changes already saved to the project's memory, with the requirement they became. */
  saved: { title: string; op: string; requirementId: string | null }[];
  /** What each ticket this suggestion updates says in Jira now, by key, to show what changes. */
  current: Record<string, { summary: string; description: string }>;
  /**
   * For a draft that new information changed while it waited: per step (by position), the ticket
   * text as the draft had it before, or "new" for a step the new information added.
   */
  redraft: Record<number, { summary: string; description: string } | "new">;
  /** Every version of the card, oldest first, with what changed and why; empty when it never changed. */
  versions: {
    version: number;
    at: Date;
    cause: string;
    reason: string;
    summary: string;
    changes: string[];
    sources: { title: string; url: string | null; source: string }[];
  }[];
  /** Jira projects a new ticket can go to, and where one goes when it names none. */
  jira: { projects: JiraProjectChoice[]; fallback: string | null; site: string | null };
};

/** What the latest items changed in a waiting draft, step by step. Empty when it was never redrafted. */
export function redraftOf(plan: Plan, previous: Plan | null): Notification["redraft"] {
  if (!previous) return {};
  const textOf = (a: Plan["actions"][number]) =>
    a.type === "jira_create" || a.type === "jira_update" ? { summary: a.summary ?? "", description: a.description ?? "" } : null;
  const idOf = (a: Plan["actions"][number]) => ("requirementRef" in a ? `${a.type}:${a.requirementRef}` : null);
  const before = new Map<string, { summary: string; description: string }>();
  for (const a of previous.actions) {
    const id = idOf(a);
    const text = textOf(a);
    if (id && text && !before.has(id)) before.set(id, text);
  }
  const out: Notification["redraft"] = {};
  plan.actions.forEach((a, i) => {
    const id = idOf(a);
    const text = textOf(a);
    if (!id || !text) return;
    const was = before.get(id);
    if (!was) out[i] = "new";
    else if (was.summary !== text.summary || was.description !== text.description) out[i] = was;
  });
  return out;
}

const currentCache = new Map<string, { at: number; summary: string; description: string }>();

/** The tickets' title and description as Jira has them now (a minute's cache), else ISA's last snapshot. */
async function currentTickets(keys: string[]): Promise<Record<string, { summary: string; description: string }>> {
  const out: Record<string, { summary: string; description: string }> = {};
  const want = [...new Set(keys)].filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k));
  const stale = want.filter((k) => {
    const hit = currentCache.get(k);
    if (hit && Date.now() - hit.at < 60_000) out[k] = { summary: hit.summary, description: hit.description };
    return !out[k];
  });
  if (!stale.length) return out;
  const jira = jiraSearcher();
  try {
    if (jira && "ticketDetails" in jira) {
      for (const t of await (jira as JiraClient).ticketDetails(stale)) {
        out[t.key] = { summary: t.summary, description: t.description };
        currentCache.set(t.key, { at: Date.now(), ...out[t.key] });
      }
    }
  } catch (err) {
    log.error("jira current text failed", err);
  }
  const missing = stale.filter((k) => !out[k]);
  if (missing.length) {
    const rows = await db
      .select({ key: schema.jiraTickets.key, summary: schema.jiraTickets.summary, description: schema.jiraTickets.description })
      .from(schema.jiraTickets)
      .where(inArray(schema.jiraTickets.key, missing));
    for (const r of rows) out[r.key] = { summary: r.summary, description: r.description };
  }
  return out;
}

export async function notifications(channelId: string | null): Promise<Notification[]> {
  const rows = await db.query.proposals.findMany({
    where: and(
      inArray(schema.proposals.status, [...WAITING]),
      channelId
        ? and(eq(schema.proposals.projectId, channelId), inArray(schema.proposals.kind, ["update", "new_project"]))
        : or(eq(schema.proposals.kind, "clarify"), isNull(schema.proposals.projectId)),
    ),
    orderBy: desc(schema.proposals.createdAt),
  });
  if (!rows.length) return [];

  const eventIds = [...new Set(rows.flatMap((r) => r.eventIds))];
  const events = eventIds.length
    ? await db
        .select({ id: schema.events.id, source: schema.events.source, title: schema.events.title, url: schema.events.url, author: schema.events.author, at: schema.events.occurredAt })
        .from(schema.events)
        .where(inArray(schema.events.id, eventIds))
    : [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const versions = await cardVersions(rows.filter((r) => r.status === "pending").map((r) => r.id));
  const questions = await missingTypeQuestions(rows);
  const projects = rows.some((r) => r.kind === "clarify")
    ? await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt))
    : [];
  const epics = channelId
    ? await db
        .select({ key: schema.jiraTickets.key, summary: schema.jiraTickets.summary, issueType: schema.jiraTickets.issueType })
        .from(schema.jiraTickets)
        .where(and(eq(schema.jiraTickets.projectId, channelId), isNull(schema.jiraTickets.deletedAt)))
    : [];
  const asks = await getSettings();
  const creates = rows.some((r) => r.plan.actions.some((a) => a.type === "jira_create" && a.kind !== "epic"));
  const sprints = asks.askSprint && creates ? await openSprintNames(await jiraKeyFor(channelId)) : [];
  const anyCreate = rows.some((r) => r.plan.actions.some((a) => a.type === "jira_create"));
  const jiraProjects = anyCreate ? await jiraProjectChoices() : [];
  const jiraSite = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "") || null;
  const fallbacks = new Map<string | null, string | null>();
  if (anyCreate) for (const pid of new Set(rows.map((r) => r.projectId))) fallbacks.set(pid, await jiraKeyFor(pid));
  const updating = rows.flatMap((r) => r.plan.actions.flatMap((a) => (a.type === "jira_update" && a.issueKey ? [a.issueKey] : [])));
  const current = updating.length ? await currentTickets(updating) : {};
  const existingEpics = epics
    .filter((t) => /^(epic|[eé]pico|[eé]pica|epique)$/i.test(t.issueType ?? ""))
    .map((t) => ({ key: t.key, label: `${t.key} ${t.summary}` }));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    plan: r.plan,
    error: r.error,
    createdAt: r.createdAt,
    saved: r.memoryAppliedAt ? r.plan.requirementChanges.map((c) => ({ title: c.title, op: c.op, requirementId: r.refs[c.ref] ?? null })) : [],
    sources: r.eventIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    existingEpics: r.plan.actions.some((a) => a.type === "jira_create" && (a.kind === "epic" || asks.askEpic)) ? existingEpics : [],
    places:
      r.kind === "clarify"
        ? [
            ...projects.filter((p) => p.id === r.projectId).map((p) => ({ projectId: p.id, name: p.name, best: true })),
            ...projects.filter((p) => p.id !== r.projectId).map((p) => ({ projectId: p.id, name: p.name, best: false })),
          ]
        : [],
    question: questions.find((q) => q.proposalId === r.id) ?? null,
    asks,
    sprints,
    redraft: r.status === "pending" ? redraftOf(r.plan, r.previousPlan) : {},
    versions: (versions.get(r.id) ?? []).map((v, i, all) => ({
      version: v.version,
      at: v.createdAt,
      cause: v.cause,
      reason: v.reason,
      summary: v.plan.summary,
      changes: i ? versionChanges(all[i - 1].plan, v.plan) : [],
      sources: v.eventIds.flatMap((id) => (byId.has(id) ? [{ title: byId.get(id)!.title, url: byId.get(id)!.url, source: byId.get(id)!.source }] : [])),
    })),
    jira: { projects: jiraProjects, fallback: fallbacks.get(r.projectId) ?? null, site: jiraSite },
    current: Object.fromEntries(
      r.plan.actions.flatMap((a) => (a.type === "jira_update" && a.issueKey && current[a.issueKey] ? [[a.issueKey, current[a.issueKey]]] : [])),
    ),
  }));
}

/** One-line records of what the owner decided in a channel, for its history. */
export async function decisions(channelId: string | null): Promise<{ id: string; at: Date; text: string }[]> {
  const rows = await db.query.proposals.findMany({
    where: and(
      inArray(schema.proposals.status, ["approved", "executed", "dismissed"]),
      channelId ? and(eq(schema.proposals.projectId, channelId), inArray(schema.proposals.kind, ["update", "new_project"])) : eq(schema.proposals.kind, "clarify"),
    ),
    orderBy: desc(schema.proposals.decidedAt),
    limit: 30,
  });
  return rows.map((p) => {
    const steps = p.plan.actions.length;
    const what =
      p.status === "dismissed"
        ? `You marked "${p.title}" as not needed.`
        : p.kind === "clarify"
          ? `You filed "${p.title.replace(/^Where does |^Is /, "").replace(/ belong\?$| about .*\?$/, "")}". ISA drafted its tickets in that project.`
          : `You approved "${p.title}"${steps ? ` (${steps} step${steps === 1 ? "" : "s"})` : ""}.${p.status === "executed" ? ` Done.${p.error ? ` Note: ${p.error}` : ""}` : " ISA is doing it."}`;
    return { id: p.id, at: p.decidedAt ?? p.updatedAt, text: what };
  });
}
