import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeAction, type Action } from "@/lib/plan";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Teams",
  gmail: "Email",
  slack: "Slack",
  manual: "Note",
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
    db
      .select()
      .from(schema.actions)
      .where(and(eq(schema.actions.projectId, id), inArray(schema.actions.status, ["done", "failed"])))
      .orderBy(desc(schema.actions.createdAt)),
    db.query.projectRules.findMany({ where: eq(schema.projectRules.projectId, id) }),
  ]);

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

  type Item = { at: Date; kind: "event" | "action"; title: string; detail: string; url: string | null; failed?: boolean };
  const timeline: Item[] = [
    ...evs.map((e) => ({
      at: e.occurredAt,
      kind: "event" as const,
      title: `${SOURCE_LABEL[e.source] ?? e.source}: ${e.title}`,
      detail: noteByEvent.get(e.id) || (e.author ? `From ${e.author}` : ""),
      url: e.url,
    })),
    ...actionRows.map((a) => {
      const result = (a.result ?? {}) as { url?: string };
      return {
        at: a.createdAt,
        kind: "action" as const,
        title: `ISA: ${describeAction(a.payload as Action)}`,
        detail: a.status === "failed" ? (a.error ?? "Failed") : "",
        url: result.url ?? null,
        failed: a.status === "failed",
      };
    }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        {project.summary ? <p className="mt-2 text-sm">{project.summary}</p> : null}
      </section>

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

      {rules.length ? (
        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Your rules for ISA</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {rules.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Timeline</h2>
        <ol className="mt-3 space-y-3">
          {timeline.map((t, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="w-28 shrink-0 text-xs text-muted">
                {t.at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
              <div>
                {t.url ? (
                  <a href={t.url} target="_blank" rel="noreferrer" className="font-medium underline">
                    {t.title}
                  </a>
                ) : (
                  <span className="font-medium">{t.title}</span>
                )}
                {t.detail ? <p className={t.failed ? "text-danger" : "text-muted"}>{t.detail}</p> : null}
              </div>
            </li>
          ))}
          {timeline.length === 0 ? <li className="text-sm text-muted">Nothing yet.</li> : null}
        </ol>
      </section>
    </div>
  );
}

function jiraUrl(key: string) {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : "#";
}
