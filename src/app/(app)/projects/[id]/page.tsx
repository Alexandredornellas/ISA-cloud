import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeAction } from "@/lib/plan";
import { addRule, redraftItem, removeRule } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";
import { describeChange } from "@/lib/jira-track";
import { withSources } from "@/lib/queries";

export const dynamic = "force-dynamic";

const RELATION_LABEL: Record<string, string> = {
  new: "New requirement",
  clarification: "Clarification",
  approval: "Approval",
  change: "Change",
  context: "Context",
};

const PROPOSAL_LABEL: Record<string, string> = {
  pending: "Pending review",
  approved: "Approved, running",
  executed: "Approved and done",
  failed: "Approved, something failed",
  dismissed: "Dismissed",
};

const PROPOSAL_STYLE: Record<string, string> = {
  pending: "font-medium text-warn",
  executed: "text-ok",
  failed: "text-danger",
  dismissed: "text-muted line-through",
};

const SOURCE_LABEL: Record<string, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Teams",
  gmail: "Email",
  slack: "Slack",
  manual: "Note",
  jira: "Jira",
};

const STATUS_STYLE: Record<string, string> = {
  proposed: "text-muted",
  approved: "text-ok",
  changed: "text-warn",
  done: "text-ok",
  dropped: "text-muted line-through",
};

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
  if (!project) notFound();

  const [requirements, links, actionRows, rules] = await Promise.all([
    db.query.requirements.findMany({
      where: eq(schema.requirements.projectId, id),
      orderBy: asc(schema.requirements.createdAt),
    }),
    db.select().from(schema.eventProjects).where(eq(schema.eventProjects.projectId, id)),
    db.select().from(schema.actions).where(eq(schema.actions.projectId, id)).orderBy(asc(schema.actions.position)),
    db.query.projectRules.findMany({ where: eq(schema.projectRules.projectId, id) }),
  ]);
  const ticketChanges = await db
    .select()
    .from(schema.ticketChanges)
    .where(and(eq(schema.ticketChanges.projectId, id), eq(schema.ticketChanges.byIsa, "no")))
    .orderBy(desc(schema.ticketChanges.changedAt))
    .limit(30);
  const proposals = await withSources(
    (await db.query.proposals.findMany({ where: eq(schema.proposals.projectId, id), orderBy: desc(schema.proposals.createdAt) })).map((p) => ({
      ...p,
      projectName: project.name,
    })),
  );
  const pendingReview = proposals.filter((p) => p.status === "pending");

  const evs = links.length
    ? await db
        .select()
        .from(schema.events)
        .where(
          inArray(
            schema.events.id,
            links.map((l) => l.eventId),
          ),
        )
    : [];
  const noteByEvent = new Map(links.map((l) => [l.eventId, l.note]));

  const relationOf = new Map(links.map((l) => [l.eventId, l.relation]));
  const actionsOf = (proposalId: string) => actionRows.filter((a) => a.proposalId === proposalId);

  // The change log: every item that changed something here, where it happened, and what ISA
  // proposed or did about it; plus changes people made directly in Jira.
  type Entry =
    | { kind: "event"; at: Date; event: (typeof evs)[number] }
    | { kind: "jira"; at: Date; change: (typeof ticketChanges)[number] };
  const log: Entry[] = [
    ...evs.map((e) => ({ kind: "event" as const, at: e.occurredAt, event: e })),
    ...ticketChanges.map((c) => ({ kind: "jira" as const, at: c.changedAt, change: c })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <Link
          href={`/?c=${project.id}`}
          className="mt-2 inline-block rounded-lg border border-line px-3 py-1.5 text-sm font-medium"
        >
          Open the project channel
        </Link>
        {project.summary ? <p className="mt-2 text-sm">{project.summary}</p> : null}
      </section>

      {pendingReview.length ? (
        <Link
          href={`/?c=${project.id}`}
          className="block rounded-xl border border-warn bg-surface px-4 py-3 text-sm font-medium text-warn"
        >
          {pendingReview.length} suggestion{pendingReview.length === 1 ? "" : "s"} waiting for you in the project channel →
        </Link>
      ) : null}

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Plan</h2>
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
          {requirements.map((r) => (
            <li key={r.id} className="p-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className={`font-medium ${r.status === "dropped" ? "line-through text-muted" : ""}`}>
                  {r.title}
                </span>
                <span className="shrink-0 text-xs">
                  <span className={STATUS_STYLE[r.status]}>{r.status}</span>
                  {r.jiraIssueKey ? (
                    <a
                      className="ml-2 text-accent underline"
                      href={jiraUrl(r.jiraIssueKey)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.jiraIssueKey}
                      {r.jiraStatus ? ` · ${r.jiraStatus}` : ""}
                    </a>
                  ) : null}
                </span>
              </div>
              {r.description ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{r.description}</p> : null}
              {r.approvedBy ? <p className="mt-1 text-xs text-ok">Approved by {r.approvedBy}</p> : null}
            </li>
          ))}
          {requirements.length === 0 ? <li className="p-4 text-sm text-muted">No requirements yet.</li> : null}
        </ul>
      </section>

      {project.people.length ? (
        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">People</h2>
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {project.people.map((p) => (
              <li key={p.name} className="rounded-full border border-line bg-surface px-3 py-1">
                {p.name}
                {p.role ? <span className="text-muted"> · {p.role}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}



      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Your rules for ISA</h2>
        {rules.length ? (
          <ul className="mt-3 space-y-1 text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3">
                <span>{r.text}</span>
                <form action={removeRule}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-xs text-muted hover:text-danger">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form action={addRule} className="mt-3 flex gap-2">
          <input type="hidden" name="projectId" value={project.id} />
          <input
            name="text"
            placeholder="e.g. Ana approves all design changes"
            className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          />
          <button className="rounded-lg border border-line px-4 py-2 text-sm font-medium">Add rule</button>
        </form>
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Change log</h2>
        <ol className="mt-3 space-y-4">
          {log.map((entry) => {
            const when = entry.at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            if (entry.kind === "jira") {
              const c = entry.change;
              return (
                <li key={c.id} className="flex gap-3 text-sm">
                  <span className="w-28 shrink-0 text-xs text-muted">{when}</span>
                  <div>
                    <a href={jiraUrl(c.key)} target="_blank" rel="noreferrer" className="font-medium underline">
                      Jira: {c.key}
                    </a>
                    <p className="text-muted">{describeChange(c)}</p>
                  </div>
                </li>
              );
            }
            const e = entry.event;
            const relation = relationOf.get(e.id) ?? "context";
            const fromHere = proposals.filter((p) => p.eventIds.includes(e.id));
            return (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className="w-28 shrink-0 text-xs text-muted">{when}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    {e.url ? (
                      <a href={e.url} target="_blank" rel="noreferrer" className="font-medium underline">
                        {SOURCE_LABEL[e.source] ?? e.source}: {e.title}
                      </a>
                    ) : (
                      <span className="font-medium">
                        {SOURCE_LABEL[e.source] ?? e.source}: {e.title}
                      </span>
                    )}
                    <span className="rounded bg-bg px-1.5 py-0.5 text-xs text-muted">{RELATION_LABEL[relation] ?? relation}</span>
                  </div>
                  <p className="text-muted">
                    {noteByEvent.get(e.id) || "No change noted."}
                    {e.author ? ` From ${e.author}.` : ""}
                  </p>
                  {fromHere.map((p) => {
                    const done = actionsOf(p.id);
                    return (
                      <div key={p.id} className="mt-2 rounded-lg border border-line bg-surface p-3">
                        <p className="text-xs">
                          <span className={PROPOSAL_STYLE[p.status] ?? "text-muted"}>{PROPOSAL_LABEL[p.status] ?? p.status}</span>
                          <span className="text-muted"> · {p.plan.summary}</span>
                        </p>
                        {p.plan.actions.length ? (
                          <ul className="mt-1 space-y-0.5">
                            {p.plan.actions.map((a, i) => {
                              const run = done[i];
                              const url = (run?.result as { url?: string } | null)?.url;
                              return (
                                <li key={i} className={run?.status === "failed" ? "text-danger" : ""}>
                                  {p.status === "pending" || p.status === "dismissed" ? "Would: " : run?.status === "done" ? "Done: " : run?.status === "failed" ? "Failed: " : ""}
                                  {url ? (
                                    <a href={url} target="_blank" rel="noreferrer" className="underline">
                                      {describeAction(a)}
                                    </a>
                                  ) : (
                                    describeAction(a)
                                  )}
                                  {run?.status === "failed" && run.error ? <span className="block text-xs">{run.error}</span> : null}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                        {p.status === "pending" ? <p className="mt-1 text-xs text-muted">Waiting for your review above.</p> : null}
                      </div>
                    );
                  })}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted hover:text-ink">Show full text</summary>
                    <p className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 text-sm">{e.content}</p>
                    <form action={redraftItem} className="mt-2">
                      <input type="hidden" name="projectId" value={project.id} />
                      <input type="hidden" name="eventId" value={e.id} />
                      <SubmitButton className="border border-line">Draft tickets again from this</SubmitButton>
                    </form>
                  </details>
                </div>
              </li>
            );
          })}
          {log.length === 0 ? <li className="text-sm text-muted">Nothing yet.</li> : null}
        </ol>
      </section>
    </div>
  );
}

function jiraUrl(key: string) {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : "#";
}
