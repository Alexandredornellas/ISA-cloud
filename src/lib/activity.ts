// What happened in a project (or in all of them), newest first: items ISA heard about, what she
// proposed or did about each, and changes people made directly in Jira.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeAction } from "@/lib/plan";
import { describeChange } from "@/lib/jira-track";
import { diffWords, type DiffPart } from "@/lib/diff";

export type Step = { text: string; state: "would" | "done" | "failed" | "pending"; url: string | null; error: string | null };

export type ActivityEntry =
  | {
      kind: "item";
      id: string;
      at: Date;
      source: string;
      title: string;
      url: string | null;
      author: string | null;
      relation: string;
      note: string;
      content: string;
      projectId: string;
      projectName: string;
      outcomes: { id: string; status: string; summary: string; steps: Step[] }[];
      /** The requirement this item changed, as it read before and after, when ISA has both. */
      change: Change | null;
    }
  | { kind: "jira"; id: string; at: Date; key: string; text: string; url: string; projectId: string | null; projectName: string; author: string | null; change: Change | null };

/** One change as "before → after": what changed (a requirement title, a ticket field) and both values. */
export type Change = { subject: string | null; from: string; to: string };

type VersionRow = Pick<typeof schema.requirementVersions.$inferSelect, "requirementId" | "version" | "title" | "description" | "status" | "eventIds">;

const clip = (t: string, max = 70) => (t.length > max ? `${t.slice(0, max).trimEnd()}…` : t);

/**
 * The change an item made to a requirement: the version it produced against the one before it.
 * A new title reads title → title. A reworded description reads as just the words that went
 * and the words that came, under the requirement's name. `from` is empty when words were only added.
 */
export function changeFrom(eventId: string, versions: VersionRow[]): Change | null {
  for (const v of versions) {
    if (v.version < 2 || !v.eventIds.includes(eventId)) continue;
    const prev = versions.find((p) => p.requirementId === v.requirementId && p.version === v.version - 1);
    if (!prev) continue;
    if (prev.title !== v.title) return { subject: null, from: prev.title, to: v.title };
    if (prev.description !== v.description && v.description) {
      const parts = diffWords(prev.description, v.description);
      const words = (kind: "removed" | "added") => parts.filter((p) => p.kind === kind).map((p) => p.text.trim()).filter(Boolean).join(" … ");
      let [from, to] = [words("removed"), words("added")];
      // "only." → "only, by card" is really just "by card" added: drop what both sides start with.
      let same = 0;
      while (same < from.length && same < to.length && from[same] === to[same]) same++;
      [from, to] = [from.slice(same), to.slice(same)];
      if (!/[\p{L}\p{N}]/u.test(from)) [from, to] = ["", to.replace(/^[\s\p{P}]+/u, "")];
      if (to) return { subject: v.title, from: clip(from), to: clip(to) };
    }
    if (prev.status !== v.status && (v.status === "dropped" || v.status === "done" || v.status === "approved")) return { subject: v.title, from: prev.status, to: v.status };
  }
  return null;
}

/** A change as parts to draw: a retitle keeps its shared words, anything else is old then new. */
export function changeParts(c: Change): DiffPart[] {
  if (!c.subject) return diffWords(c.from, c.to);
  return [...(c.from ? [{ kind: "removed" as const, text: c.from }] : []), { kind: "added" as const, text: c.to }];
}

const SHORT_FIELDS: Record<string, string> = { summary: "title", status: "status", assignee: "assignee", priority: "priority", Sprint: "sprint", labels: "labels", issuetype: "type" };

/** A Jira edit as before → after, for the fields short enough to read on one line. */
export function jiraChange(c: { field: string; fromValue: string | null; toValue: string | null }): Change | null {
  const label = SHORT_FIELDS[c.field];
  if (!label) return null;
  const from = c.fromValue?.trim() || "empty";
  const to = c.toValue?.trim() || "empty";
  if (from.length > 80 || to.length > 80) return null;
  return { subject: label, from, to };
}

const jiraUrl = (key: string) => {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : "#";
};

export async function activity(projectId: string | null, limit = 40): Promise<ActivityEntry[]> {
  const [projects, links, changes, versions] = await Promise.all([
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects),
    projectId
      ? db.select().from(schema.eventProjects).where(eq(schema.eventProjects.projectId, projectId))
      : db.select().from(schema.eventProjects),
    db
      .select()
      .from(schema.ticketChanges)
      .where(projectId ? and(eq(schema.ticketChanges.projectId, projectId), eq(schema.ticketChanges.byIsa, "no")) : eq(schema.ticketChanges.byIsa, "no"))
      .orderBy(desc(schema.ticketChanges.changedAt))
      .limit(limit),
    db
      .select({ requirementId: schema.requirementVersions.requirementId, version: schema.requirementVersions.version, title: schema.requirementVersions.title, description: schema.requirementVersions.description, status: schema.requirementVersions.status, eventIds: schema.requirementVersions.eventIds })
      .from(schema.requirementVersions)
      .where(projectId ? eq(schema.requirementVersions.projectId, projectId) : undefined),
  ]);
  const name = new Map(projects.map((p) => [p.id, p.name]));
  const eventIds = [...new Set(links.map((l) => l.eventId))];
  const [events, proposals, actions] = await Promise.all([
    eventIds.length
      ? db.select().from(schema.events).where(inArray(schema.events.id, eventIds)).orderBy(desc(schema.events.occurredAt)).limit(limit)
      : Promise.resolve([]),
    db.query.proposals.findMany({
      where: projectId ? eq(schema.proposals.projectId, projectId) : undefined,
      orderBy: desc(schema.proposals.createdAt),
    }),
    db
      .select()
      .from(schema.actions)
      .where(projectId ? eq(schema.actions.projectId, projectId) : undefined)
      .orderBy(asc(schema.actions.position)),
  ]);

  const items: ActivityEntry[] = [];
  for (const e of events) {
    // In the all-projects feed an item filed under two projects shows once, under the first.
    const link = links.find((l) => l.eventId === e.id && (!projectId || l.projectId === projectId));
    if (!link) continue;
    const outcomes = proposals
      .filter((p) => p.eventIds.includes(e.id) && p.kind !== "clarify" && (!projectId || p.projectId === projectId))
      .map((p) => {
        const runs = actions.filter((a) => a.proposalId === p.id);
        return {
          id: p.id,
          status: p.status,
          summary: p.plan.summary,
          steps: p.plan.actions.map((a, i): Step => {
            const run = runs.find((r) => r.position === i);
            return {
              text: describeAction(a),
              state: p.status === "pending" || p.status === "dismissed" ? "would" : run?.status === "done" ? "done" : run?.status === "failed" ? "failed" : "pending",
              url: (run?.result as { url?: string } | null)?.url ?? null,
              error: run?.status === "failed" ? run.error : null,
            };
          }),
        };
      });
    items.push({
      kind: "item",
      id: e.id,
      at: e.occurredAt,
      source: e.source,
      title: e.title,
      url: e.url,
      author: e.author?.replace(/\s*<.*>$/, "") ?? null,
      relation: link.relation,
      note: link.note,
      content: e.content,
      projectId: link.projectId,
      projectName: name.get(link.projectId) ?? "",
      outcomes,
      change: changeFrom(e.id, versions),
    });
  }
  for (const c of changes) {
    items.push({ kind: "jira", id: c.id, at: c.changedAt, key: c.key, text: describeChange(c), url: jiraUrl(c.key), projectId: c.projectId, projectName: c.projectId ? (name.get(c.projectId) ?? "") : "", author: c.author, change: jiraChange(c) });
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
