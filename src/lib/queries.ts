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

export type MissingTypeQuestion = {
  proposalId: string;
  proposalTitle: string;
  projectKey: string;
  wanted: string;
  available: string[];
  tickets: string[];
  kindNames: string[];
};

/** Questions ISA is waiting on: tickets it could not create because Jira lacks their type. */
export async function missingTypeQuestions(proposals: { id: string; title: string; status: string }[]): Promise<MissingTypeQuestion[]> {
  const failed = proposals.filter((p) => p.status === "failed");
  if (!failed.length) return [];
  const { ticketFormats } = await import("@/lib/ticket-formats");
  const formats = await ticketFormats();
  const rows = await db
    .select()
    .from(schema.actions)
    .where(and(inArray(schema.actions.proposalId, failed.map((p) => p.id)), eq(schema.actions.status, "failed")));
  const out = new Map<string, MissingTypeQuestion>();
  for (const a of rows) {
    const q = (a.result as { question?: { projectKey: string; wanted: string; available: string[] } } | null)?.question;
    if (!q) continue;
    const key = `${a.proposalId}:${q.wanted}`;
    const payload = a.payload as { summary?: string; kind?: string };
    const entry = out.get(key) ?? {
      proposalId: a.proposalId,
      proposalTitle: failed.find((p) => p.id === a.proposalId)?.title ?? "",
      projectKey: q.projectKey,
      wanted: q.wanted,
      available: q.available,
      tickets: [],
      kindNames: [],
    };
    if (payload.summary) entry.tickets.push(payload.summary);
    const name = formats.find((f) => f.kind === payload.kind)?.name;
    if (name && !entry.kindNames.includes(name)) entry.kindNames.push(name);
    out.set(key, entry);
  }
  return [...out.values()];
}
