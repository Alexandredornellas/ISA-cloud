// What happened in a project (or in all of them), newest first: items ISA heard about, what she
// proposed or did about each, and changes people made directly in Jira.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeAction } from "@/lib/plan";
import { describeChange } from "@/lib/jira-track";

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
    }
  | { kind: "jira"; id: string; at: Date; key: string; text: string; url: string; projectName: string };

const jiraUrl = (key: string) => {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : "#";
};

export async function activity(projectId: string | null, limit = 40): Promise<ActivityEntry[]> {
  const [projects, links, changes] = await Promise.all([
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
    });
  }
  for (const c of changes) {
    items.push({ kind: "jira", id: c.id, at: c.changedAt, key: c.key, text: describeChange(c), url: jiraUrl(c.key), projectName: c.projectId ? (name.get(c.projectId) ?? "") : "" });
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
