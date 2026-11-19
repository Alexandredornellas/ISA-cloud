import { desc, eq, inArray, notInArray, or, and, gt } from "drizzle-orm";
import { db, schema } from "@/db";

// Proposals for the inbox: everything pending, plus failures and results from the last day.
export async function inboxProposals() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      proposal: schema.proposals,
      projectName: schema.projects.name,
    })
    .from(schema.proposals)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.proposals.projectId))
    .where(
      or(
        eq(schema.proposals.status, "pending"),
        and(notInArray(schema.proposals.status, ["dismissed"]), gt(schema.proposals.updatedAt, since)),
      ),
    )
    .orderBy(desc(schema.proposals.createdAt));
  return withSources(rows.map((r) => ({ ...r.proposal, projectName: r.projectName })));
}

export async function withSources<T extends { eventIds: string[] }>(items: T[]) {
  const ids = [...new Set(items.flatMap((i) => i.eventIds))];
  const evs = ids.length
    ? await db
        .select({
          id: schema.events.id,
          source: schema.events.source,
          title: schema.events.title,
          url: schema.events.url,
        })
        .from(schema.events)
        .where(inArray(schema.events.id, ids))
    : [];
  const byId = new Map(evs.map((e) => [e.id, e]));
  return items.map((i) => ({
    ...i,
    sources: i.eventIds.map((id) => byId.get(id)).filter((e) => e !== undefined),
  }));
}
