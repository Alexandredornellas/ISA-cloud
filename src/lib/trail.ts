// Decision trails: for each requirement, the story of why it is what it is. Which conversations
// raised or changed it (meetings, Slack, email, Confluence), what the owner approved and why, and
// what happened to its Jira ticket. This is what answers "why did we decide X?".
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { jiraBrowseUrl } from "@/lib/jira";
import type { Plan } from "@/lib/plan";
import { versionsOf, type RequirementVersion } from "@/lib/versions";

export type TrailSource = { id: string; source: string; title: string; author: string | null; url: string | null; at: Date; note: string | null };
export type TrailEntry = {
  at: Date;
  kind: "decided" | "pending" | "discussed" | "jira";
  /** One line: what happened. */
  text: string;
  /** Why, as the owner approved it. */
  reason: string | null;
  sources: TrailSource[];
  proposalId?: string;
  /** What the requirement said before and after this step, when it changed it. */
  change?: { version: number; was: RequirementVersion | null; now: RequirementVersion };
};
export type Trail = {
  requirement: typeof schema.requirements.$inferSelect;
  project: { id: string; name: string };
  ticket: { key: string; status: string | null; url: string } | null;
  entries: TrailEntry[];
  /** Every version it has had, oldest first. */
  versions: RequirementVersion[];
};

type ProposalRow = typeof schema.proposals.$inferSelect;

/** Whether a proposal touched this requirement: by id, by a ref mapped to it, or by its Jira key. */
function touches(p: ProposalRow, reqId: string, key: string | null): { changes: Plan["requirementChanges"]; jira: boolean } {
  const resolve = (ref: string) => p.refs[ref] ?? ref;
  const changes = p.plan.requirementChanges.filter((c) => resolve(c.ref) === reqId);
  const jira = p.plan.actions.some(
    (a) => ("issueKey" in a && key && a.issueKey === key) || ("requirementRef" in a && resolve(a.requirementRef) === reqId),
  );
  return { changes, jira };
}

const OP_TEXT = { create: "Added", update: "Changed", drop: "Dropped" } as const;

export async function decisionTrail(requirementId: string): Promise<Trail | null> {
  const req = await db.query.requirements.findFirst({ where: eq(schema.requirements.id, requirementId) });
  if (!req) return null;
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, req.projectId) });
  if (!project) return null;

  const [proposals, linked, versions] = await Promise.all([
    db.query.proposals.findMany({
      where: and(eq(schema.proposals.projectId, req.projectId), inArray(schema.proposals.status, ["pending", "approved", "executed", "failed"])),
      orderBy: asc(schema.proposals.createdAt),
    }),
    // Items the sorting step tied to this requirement.
    db
      .select({ e: schema.events, note: schema.eventProjects.note })
      .from(schema.events)
      .leftJoin(schema.eventProjects, and(eq(schema.eventProjects.eventId, schema.events.id), eq(schema.eventProjects.projectId, req.projectId)))
      .where(sql`${schema.events.sortResult} -> 'matches' @> ${JSON.stringify([{ requirementIds: [requirementId] }])}::jsonb`),
    versionsOf(requirementId),
  ]);
  const changeOf = (v: RequirementVersion | undefined) => (v ? { version: v.version, was: versions.find((x) => x.version === v.version - 1) ?? null, now: v } : undefined);

  const entries: TrailEntry[] = [];
  const used = new Set<string>();
  const eventIds = [...new Set(proposals.flatMap((p) => p.eventIds))];
  const events = eventIds.length
    ? await db
        .select({ e: schema.events, note: schema.eventProjects.note })
        .from(schema.events)
        .leftJoin(schema.eventProjects, and(eq(schema.eventProjects.eventId, schema.events.id), eq(schema.eventProjects.projectId, req.projectId)))
        .where(inArray(schema.events.id, eventIds))
    : [];
  const eventOf = new Map(events.map((r) => [r.e.id, toSource(r.e, r.note)]));

  for (const p of proposals) {
    const { changes, jira } = touches(p, req.id, req.jiraIssueKey);
    if (!changes.length && !jira) continue;
    const sources = p.eventIds.map((id) => eventOf.get(id)).filter((s): s is TrailSource => !!s);
    sources.forEach((s) => used.add(s.id));
    // Saved to memory when filed: a decision on record, even if its Jira steps still wait.
    const pending = p.status === "pending" && !(changes.length && p.memoryAppliedAt);
    const change = changes[0];
    entries.push({
      at: p.decidedAt ?? p.memoryAppliedAt ?? p.createdAt,
      kind: pending ? "pending" : "decided",
      text: change ? `${OP_TEXT[change.op]}: ${change.title}${change.approvedBy ? `, approved by ${change.approvedBy}` : ""}` : p.title,
      reason: change?.reason || p.plan.summary || null,
      sources,
      proposalId: p.id,
      change: changeOf(versions.findLast((v) => v.proposalId === p.id)),
    });
  }
  // Changes made outside a filed item: by hand, or when Jira marked the ticket done.
  for (const v of versions) {
    if (v.proposalId || v.version === 1) continue;
    const who = v.changedBy === "you" ? "You" : v.changedBy === "Jira" ? "Jira sync" : "Someone";
    entries.push({ at: v.validFrom, kind: "decided", text: `${who} changed it to ${v.status}`, reason: v.reason, sources: [], change: changeOf(v) });
  }
  for (const r of linked) {
    if (used.has(r.e.id)) continue;
    const s = toSource(r.e, r.note);
    entries.push({ at: s.at, kind: "discussed", text: `Came up in ${s.title}`, reason: null, sources: [s] });
  }
  if (req.jiraIssueKey) {
    const changes = await db
      .select()
      .from(schema.ticketChanges)
      .where(and(eq(schema.ticketChanges.key, req.jiraIssueKey), eq(schema.ticketChanges.byIsa, "no")))
      .orderBy(asc(schema.ticketChanges.changedAt));
    for (const c of changes) {
      entries.push({
        at: c.changedAt,
        kind: "jira",
        text: `${c.author ?? "Someone"} changed the ${c.field} of ${c.key} in Jira${c.toValue && c.field === "status" ? ` to ${c.toValue}` : ""}`,
        reason: c.field !== "status" && c.toValue ? `Now: “${c.toValue.slice(0, 200)}”${c.fromValue ? ` (was “${c.fromValue.slice(0, 120)}”)` : ""}` : null,
        sources: [],
      });
    }
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    requirement: req,
    project: { id: project.id, name: project.name },
    ticket: req.jiraIssueKey ? { key: req.jiraIssueKey, status: req.jiraStatus, url: jiraBrowseUrl(req.jiraIssueKey) } : null,
    entries,
    versions,
  };
}

function toSource(e: typeof schema.events.$inferSelect, note: string | null): TrailSource {
  return { id: e.id, source: e.source, title: e.title, author: e.author, url: e.url, at: e.occurredAt, note: note || null };
}

export type DecisionRow = {
  id: string;
  title: string;
  status: string;
  approvedBy: string | null;
  projectId: string;
  projectName: string;
  jiraIssueKey: string | null;
  updatedAt: Date;
};

/** Requirements across projects (or one), newest change first, matching an optional search. */
export async function decisionList(opts: { query?: string | null; projectId?: string | null; limit?: number } = {}): Promise<DecisionRow[]> {
  const q = opts.query?.trim();
  const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
  return db
    .select({
      id: schema.requirements.id,
      title: schema.requirements.title,
      status: schema.requirements.status,
      approvedBy: schema.requirements.approvedBy,
      projectId: schema.projects.id,
      projectName: schema.projects.name,
      jiraIssueKey: schema.requirements.jiraIssueKey,
      updatedAt: schema.requirements.updatedAt,
    })
    .from(schema.requirements)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.requirements.projectId))
    .where(
      and(
        opts.projectId ? eq(schema.requirements.projectId, opts.projectId) : undefined,
        like
          ? or(ilike(schema.requirements.title, like), ilike(schema.requirements.description, like), ilike(schema.requirements.jiraIssueKey, like), ilike(schema.projects.name, like))
          : undefined,
      ),
    )
    .orderBy(desc(schema.requirements.updatedAt))
    .limit(opts.limit ?? 200);
}

/** What ISA's memory holds, by kind, for the home screen. */
export async function memoryStats() {
  const [bySource, reqs, tickets, people] = await Promise.all([
    db.select({ source: schema.events.source, n: sql<number>`count(*)::int` }).from(schema.events).where(inArray(schema.events.status, ["sorted", "unsure"])).groupBy(schema.events.source),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.requirements),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.jiraTickets),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.people),
  ]);
  const count = (s: string[]) => bySource.filter((r) => s.includes(r.source)).reduce((n, r) => n + r.n, 0);
  return {
    meetings: count(["zoom", "meet", "teams"]),
    slack: count(["slack"]),
    email: count(["gmail"]),
    confluence: count(["confluence"]),
    decisions: reqs[0]?.n ?? 0,
    tickets: tickets[0]?.n ?? 0,
    people: people[0]?.n ?? 0,
  };
}

/** A trail as text for Claude, with sources to cite. */
export function trailText(t: Trail): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return [
    `Requirement [${t.requirement.id}] "${t.requirement.title}" in project ${t.project.name}. Status: ${t.requirement.status}${t.requirement.approvedBy ? `, approved by ${t.requirement.approvedBy}` : ""}.`,
    t.requirement.description ? `Now: ${t.requirement.description}` : null,
    t.ticket ? `Jira: ${t.ticket.key} (${t.ticket.status ?? "unknown status"}) ${t.ticket.url}` : "No Jira ticket yet.",
    "Trail, oldest first:",
    ...(t.entries.length
      ? t.entries.map(
          (e) =>
            `- ${fmt(e.at)} [${e.kind}] ${e.text}${e.reason ? `. Why: ${e.reason}` : ""}${
              e.sources.length ? `. Sources: ${e.sources.map((s) => `${s.source} "${s.title}"${s.author ? ` by ${s.author}` : ""} on ${fmt(s.at)}${s.url ? ` ${s.url}` : ""}${s.note ? ` (${s.note})` : ""}`).join("; ")}` : ""
            }`,
        )
      : ["(no recorded history: it may predate ISA)"]),
    "Versions, oldest first (each was in force from its date until the next one):",
    ...t.versions.map((v) => versionLine(v)),
  ]
    .filter(Boolean)
    .join("\n");
}

/** One version as a line for Claude. */
export function versionLine(v: RequirementVersion): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `- v${v.version} from ${fmt(v.validFrom)}${v.validTo ? ` to ${fmt(v.validTo)}` : " (current)"}: "${v.title}" [${v.status}${v.approvedBy ? `, approved by ${v.approvedBy}` : ""}] ${v.description.slice(0, 400)}${v.reason ? `. Why: ${v.reason}` : ""}. Changed by ${v.changedBy}.`;
}
