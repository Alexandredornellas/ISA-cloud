import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JiraClient, TicketDetail } from "@/lib/jira";

export type JiraTracker = Pick<JiraClient, "ticketDetails" | "changelog" | "myAccountId">;

// An edit by ISA's Jira account this close to one of ISA's own writes is ISA's, not a person's.
const ISA_WINDOW_MS = 3 * 60_000;
const MAX_TEXT = 4000;

export type TrackedChange = typeof schema.ticketChanges.$inferSelect;

/**
 * Keep a snapshot of every ticket ISA manages and record each change made to it in Jira:
 * who changed which field, from what, to what, and when. Jira's own change history is the
 * source, so nothing is lost between passes. Returns the new changes made by people (not ISA).
 */
export async function trackJira(jira: JiraTracker): Promise<{ tracked: number; deleted: number; changes: TrackedChange[] }> {
  const reqs = await db
    .select({ key: schema.requirements.jiraIssueKey, projectId: schema.requirements.projectId })
    .from(schema.requirements)
    .where(isNotNull(schema.requirements.jiraIssueKey));
  const snaps = await db.select().from(schema.jiraTickets).where(isNull(schema.jiraTickets.deletedAt));
  const projectOf = new Map<string, string | null>(snaps.map((s) => [s.key, s.projectId]));
  for (const r of reqs) projectOf.set(r.key!, r.projectId);
  const keys = [...projectOf.keys()];
  if (!keys.length) return { tracked: 0, deleted: 0, changes: [] };

  const details = await jira.ticketDetails(keys);
  const snapByKey = new Map(snaps.map((s) => [s.key, s]));
  let me: string | null = null;
  const changes: TrackedChange[] = [];

  for (const d of details) {
    const snap = snapByKey.get(d.key);
    const projectId = projectOf.get(d.key) ?? null;
    if (snap?.jiraUpdatedAt && d.updated && snap.jiraUpdatedAt.getTime() === d.updated.getTime()) {
      if (snap.projectId !== projectId) await db.update(schema.jiraTickets).set({ projectId }).where(eq(schema.jiraTickets.key, d.key));
      continue;
    }
    const history = await jira.changelog(d.key);
    const maxId = history.reduce((m, h) => (Number(h.id) > m ? Number(h.id) : m), Number(snap?.historySeenUpTo ?? 0));

    // The first time ISA sees a ticket it only takes a snapshot; history before that is not news.
    if (snap?.jiraUpdatedAt) {
      me ??= await jira.myAccountId().catch(() => null);
      const writes = snap.isaWrites.map((t) => new Date(t).getTime());
      const seen = Number(snap.historySeenUpTo ?? 0);
      for (const h of history.filter((x) => Number(x.id) > seen)) {
        const byIsa = !!me && h.authorAccountId === me && writes.some((t) => Math.abs(t - h.at.getTime()) < ISA_WINDOW_MS);
        for (const item of h.items) {
          const [row] = await db
            .insert(schema.ticketChanges)
            .values({
              key: d.key,
              projectId,
              historyId: h.id,
              field: item.field,
              fromValue: item.from?.slice(0, MAX_TEXT) ?? null,
              toValue: item.to?.slice(0, MAX_TEXT) ?? null,
              author: h.author,
              authorAccountId: h.authorAccountId,
              byIsa: byIsa ? "yes" : "no",
              changedAt: h.at,
            })
            .onConflictDoNothing()
            .returning();
          if (row && !byIsa) changes.push(row);
        }
      }
    }
    await saveSnapshot(d, projectId, maxId ? String(maxId) : null, snap?.isaWrites ?? []);
  }

  // Tickets ISA tracked that Jira no longer returns were deleted there.
  const found = new Set(details.map((d) => d.key));
  let deleted = 0;
  for (const s of snaps) {
    if (found.has(s.key)) continue;
    await db.update(schema.jiraTickets).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.jiraTickets.key, s.key));
    deleted += 1;
  }
  return { tracked: details.length, deleted, changes };
}

async function saveSnapshot(d: TicketDetail, projectId: string | null, historySeenUpTo: string | null, isaWrites: string[]) {
  const dayAgo = Date.now() - 24 * 3600_000;
  const values = {
    projectId,
    issueType: d.issueType,
    summary: d.summary,
    description: d.description.slice(0, 20_000),
    status: d.status,
    assignee: d.assignee,
    sprint: d.sprint,
    epic: d.epic,
    labels: d.labels,
    jiraUpdatedAt: d.updated,
    historySeenUpTo,
    isaWrites: isaWrites.filter((t) => new Date(t).getTime() > dayAgo),
    deletedAt: null,
    updatedAt: new Date(),
  };
  await db.insert(schema.jiraTickets).values({ key: d.key, ...values }).onConflictDoUpdate({ target: schema.jiraTickets.key, set: values });
}

/** Note that ISA just wrote to a ticket, so the change it made is not reported as someone else's. */
export async function recordIsaWrite(key: string, projectId: string | null = null) {
  const now = new Date().toISOString();
  const existing = await db.query.jiraTickets.findFirst({ where: eq(schema.jiraTickets.key, key) });
  if (existing) {
    await db
      .update(schema.jiraTickets)
      .set({ isaWrites: [...existing.isaWrites, now].slice(-20), projectId: projectId ?? existing.projectId, deletedAt: null, updatedAt: new Date() })
      .where(eq(schema.jiraTickets.key, key));
  } else {
    await db.insert(schema.jiraTickets).values({ key, projectId, isaWrites: [now] });
  }
}

const FIELD_LABEL: Record<string, string> = {
  summary: "title",
  description: "description",
  status: "status",
  assignee: "assignee",
  Sprint: "sprint",
  IssueParentAssociation: "epic",
  "Parent Link": "epic",
  labels: "labels",
  priority: "priority",
  issuetype: "type",
};

export function describeChange(c: Pick<TrackedChange, "key" | "field" | "fromValue" | "toValue" | "author" | "byIsa">): string {
  const field = FIELD_LABEL[c.field] ?? c.field;
  const who = c.byIsa === "yes" ? "ISA" : (c.author ?? "Someone");
  const short = (v: string | null) => (v ? (v.length > 160 ? `${v.slice(0, 160)}…` : v) : "(empty)");
  if (c.field === "description") return `${who} changed the description of ${c.key}`;
  return `${who} changed the ${field} of ${c.key} from "${short(c.fromValue)}" to "${short(c.toValue)}"`;
}

/** Recent changes to a project's tickets (or one ticket), newest first. */
export async function ticketHistory(filter: { projectId?: string; key?: string }, limit = 30) {
  return db
    .select()
    .from(schema.ticketChanges)
    .where(
      filter.key
        ? eq(schema.ticketChanges.key, filter.key)
        : filter.projectId
          ? eq(schema.ticketChanges.projectId, filter.projectId)
          : and(),
    )
    .orderBy(desc(schema.ticketChanges.changedAt))
    .limit(limit);
}
