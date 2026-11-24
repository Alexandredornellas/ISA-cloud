// ISA's home screen: one channel per project plus General. Suggestions that wait on the owner
// show as "Needs you" cards in their channel until the owner acts on them.
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { missingTypeQuestions, type MissingTypeQuestion } from "@/lib/queries";
import type { Plan } from "@/lib/plan";
import { getSettings, type Settings } from "@/lib/settings";
import { openSprintNames } from "@/lib/jira-research";
import { jiraKeyFor } from "@/lib/jira-project";
import { jiraSearcher } from "@/lib/jira-research";
import type { JiraClient } from "@/lib/jira";

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
};

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
    console.error("jira current text failed", { error: err instanceof Error ? err.name : "unknown" });
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
