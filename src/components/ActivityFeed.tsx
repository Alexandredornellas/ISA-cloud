import type { ActivityEntry } from "@/lib/activity";
import { fullTime, sourceOf, timeAgo } from "@/lib/sources";
import { SourceMark } from "@/components/SourceMark";
import { SubmitButton } from "@/components/SubmitButton";
import { redraftItem } from "@/app/(app)/projects/[id]/actions";

const RELATION: Record<string, string> = {
  new: "New requirement",
  clarification: "Clarification",
  approval: "Approval",
  change: "Change",
  context: "Context",
};

const OUTCOME: Record<string, { label: string; style: string }> = {
  pending: { label: "Waiting for you", style: "bg-warn/15 text-warn" },
  approved: { label: "ISA is doing it", style: "bg-accent-soft text-accent" },
  executed: { label: "Done", style: "bg-ok/15 text-ok" },
  failed: { label: "Something failed", style: "bg-danger/15 text-danger" },
  dismissed: { label: "Not needed", style: "bg-bg text-muted" },
};

function dayOf(d: Date, now = new Date()) {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(new Date(d))) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** What happened, newest first, grouped by day: where it came from, what ISA made of it, and what was done. */
export function ActivityFeed({ entries, showProject = false }: { entries: ActivityEntry[]; showProject?: boolean }) {
  if (!entries.length) {
    return <p className="text-sm text-muted">Nothing yet. Meetings, emails, Slack messages and Jira changes show up here as ISA picks them up.</p>;
  }
  const groups: { day: string; items: ActivityEntry[] }[] = [];
  for (const e of entries) {
    const day = dayOf(e.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(e);
  }
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.day}>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.day}</h3>
          <ol className="space-y-1">
            {g.items.map((e) => (
              <li key={`${e.kind}-${e.id}`}>{e.kind === "jira" ? <JiraRow e={e} showProject={showProject} /> : <ItemRow e={e} showProject={showProject} />}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function JiraRow({ e, showProject }: { e: Extract<ActivityEntry, { kind: "jira" }>; showProject: boolean }) {
  return (
    <div className="flex gap-2.5 rounded-lg px-1 py-1.5 text-sm">
      <SourceMark source="jira" size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline justify-between gap-2">
          <a href={e.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
            {e.key}
          </a>
          <time className="flex-none text-xs text-muted" title={fullTime(e.at)}>
            {timeAgo(e.at)}
          </time>
        </p>
        <p className="text-muted">{e.text}</p>
        {showProject && e.projectName ? <p className="text-xs text-muted">{e.projectName}</p> : null}
      </div>
    </div>
  );
}

function ItemRow({ e, showProject }: { e: Extract<ActivityEntry, { kind: "item" }>; showProject: boolean }) {
  const src = sourceOf(e.source);
  const latest = e.outcomes[0];
  const outcome = latest ? OUTCOME[latest.status] : null;
  return (
    <details className="group rounded-lg px-1 py-1.5 text-sm open:bg-bg">
      <summary className="flex cursor-pointer list-none gap-2.5">
        <SourceMark source={e.source} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{e.title}</span>
            <time className="flex-none text-xs text-muted" title={fullTime(e.at)}>
              {timeAgo(e.at)}
            </time>
          </p>
          <p className="text-xs text-muted">
            {src.label}
            {e.author ? ` · ${e.author}` : ""} · {RELATION[e.relation] ?? e.relation}
            {showProject && e.projectName ? ` · ${e.projectName}` : ""}
          </p>
          {e.note ? <p className="mt-1 line-clamp-3 text-muted group-open:line-clamp-none">{e.note}</p> : null}
          {outcome ? (
            <p className="mt-1.5 flex items-center gap-2 text-xs">
              <span className={`rounded px-1.5 py-0.5 font-medium ${outcome.style}`}>{outcome.label}</span>
              <span className="text-muted">
                {latest.steps.length} step{latest.steps.length === 1 ? "" : "s"}
                <span className="group-open:hidden"> · details</span>
              </span>
            </p>
          ) : null}
        </div>
      </summary>

      <div className="mt-2 space-y-3 pl-[34px]">
        {e.outcomes.map((o) => (
          <div key={o.id} className="rounded-lg border border-line bg-surface p-3">
            <p className="text-xs text-muted">{o.summary}</p>
            {o.steps.length ? (
              <ul className="mt-2 space-y-1">
                {o.steps.map((s, i) => (
                  <li key={i} className={`flex gap-2 text-xs ${s.state === "failed" ? "text-danger" : ""}`}>
                    <span className="w-14 flex-none text-muted">{s.state === "done" ? "Done" : s.state === "failed" ? "Failed" : s.state === "would" ? "Would" : "Running"}</span>
                    <span className="min-w-0">
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                          {s.text}
                        </a>
                      ) : (
                        s.text
                      )}
                      {s.error ? <span className="block">{s.error}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {e.url ? (
            <a href={e.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Open in {src.label}
            </a>
          ) : null}
          <details>
            <summary className="cursor-pointer text-muted hover:text-ink">Full text</summary>
            <p className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 text-sm">{e.content}</p>
          </details>
        </div>
        <form action={redraftItem}>
          <input type="hidden" name="projectId" value={e.projectId} />
          <input type="hidden" name="eventId" value={e.id} />
          <SubmitButton className="border border-line bg-surface px-3 py-1.5 text-xs">Draft tickets again from this</SubmitButton>
        </form>
      </div>
    </details>
  );
}
