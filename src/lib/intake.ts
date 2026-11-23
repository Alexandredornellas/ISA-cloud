// The intake queue: every item that reached ISA (meeting, email, Slack, Confluence page) and where
// it went. Filed to one or more projects, waiting for the owner to say which project, about no
// project, or failed. Each project keeps only its own part of an item.
import { and, arrayOverlaps, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export type IntakeFilter = "all" | "needs_you" | "filed" | "ignored" | "failed";

export type IntakeItem = {
  id: string;
  source: string;
  title: string;
  author: string | null;
  url: string | null;
  at: Date;
  status: "new" | "sorted" | "unsure" | "ignored" | "failed";
  error: string | null;
  projects: { id: string; name: string; relation: string; note: string }[];
  /** "Is this about X?" questions waiting for the owner. */
  questions: { proposalId: string; projectId: string | null; projectName: string | null; reason: string }[];
};

const STATUSES: Record<IntakeFilter, IntakeItem["status"][]> = {
  all: ["new", "sorted", "unsure", "ignored", "failed"],
  needs_you: ["unsure"],
  filed: ["sorted"],
  ignored: ["ignored"],
  failed: ["failed"],
};

export async function intakeItems(filter: IntakeFilter = "all", limit = 60): Promise<IntakeItem[]> {
  const events = await db
    .select()
    .from(schema.events)
    .where(and(inArray(schema.events.status, STATUSES[filter]), sql`${schema.events.source} <> 'jira'`))
    .orderBy(desc(schema.events.occurredAt))
    .limit(limit);
  if (!events.length) return [];
  const ids = events.map((e) => e.id);
  const [links, clarify] = await Promise.all([
    db
      .select({ eventId: schema.eventProjects.eventId, id: schema.projects.id, name: schema.projects.name, relation: schema.eventProjects.relation, note: schema.eventProjects.note })
      .from(schema.eventProjects)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.eventProjects.projectId))
      .where(inArray(schema.eventProjects.eventId, ids)),
    db
      .select({ p: schema.proposals, projectName: schema.projects.name })
      .from(schema.proposals)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.proposals.projectId))
      .where(and(eq(schema.proposals.kind, "clarify"), eq(schema.proposals.status, "pending"), arrayOverlaps(schema.proposals.eventIds, ids))),
  ]);
  return events.map((e) => ({
    id: e.id,
    source: e.source,
    title: e.title,
    author: e.author,
    url: e.url,
    at: e.occurredAt,
    status: e.status,
    error: e.error,
    projects: links.filter((l) => l.eventId === e.id).map(({ id, name, relation, note }) => ({ id, name, relation, note })),
    questions: clarify
      .filter((c) => c.p.eventIds.includes(e.id))
      .map((c) => ({ proposalId: c.p.id, projectId: c.p.projectId, projectName: c.projectName, reason: c.p.plan.summary || c.p.title })),
  }));
}

export async function intakeCounts(): Promise<Record<IntakeFilter, number>> {
  const rows = await db
    .select({ status: schema.events.status, n: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(sql`${schema.events.source} <> 'jira'`)
    .groupBy(schema.events.status);
  const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { all: n(STATUSES.all), needs_you: n(["unsure"]), filed: n(["sorted"]), ignored: n(["ignored"]), failed: n(["failed"]) };
}

/** The owner says an item is about no project: unfile it and drop what was waiting on it. */
export async function ignoreEvent(eventId: string) {
  const pending = await db.select({ id: schema.proposals.id, eventIds: schema.proposals.eventIds }).from(schema.proposals).where(eq(schema.proposals.status, "pending"));
  const stale = pending.filter((p) => p.eventIds.includes(eventId)).map((p) => p.id);
  if (stale.length) await db.update(schema.proposals).set({ status: "dismissed", decidedAt: new Date(), updatedAt: new Date() }).where(inArray(schema.proposals.id, stale));
  await db.delete(schema.eventProjects).where(eq(schema.eventProjects.eventId, eventId));
  await db.update(schema.events).set({ status: "ignored", updatedAt: new Date() }).where(eq(schema.events.id, eventId));
}

/** Take an item off one project only, keeping its other projects. */
export async function unfileEvent(eventId: string, projectId: string) {
  const pending = await db.select({ id: schema.proposals.id, eventIds: schema.proposals.eventIds }).from(schema.proposals).where(and(eq(schema.proposals.status, "pending"), eq(schema.proposals.projectId, projectId)));
  const stale = pending.filter((p) => p.eventIds.includes(eventId)).map((p) => p.id);
  if (stale.length) await db.update(schema.proposals).set({ status: "dismissed", decidedAt: new Date(), updatedAt: new Date() }).where(inArray(schema.proposals.id, stale));
  await db.delete(schema.eventProjects).where(and(eq(schema.eventProjects.eventId, eventId), eq(schema.eventProjects.projectId, projectId)));
  const left = await db.select({ p: schema.eventProjects.projectId }).from(schema.eventProjects).where(eq(schema.eventProjects.eventId, eventId));
  if (!left.length) await db.update(schema.events).set({ status: "ignored", updatedAt: new Date() }).where(eq(schema.events.id, eventId));
}
