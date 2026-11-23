import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { intakeCounts, intakeItems, type IntakeFilter, type IntakeItem } from "@/lib/intake";
import { SourceMark } from "@/components/SourceMark";
import { SubmitButton } from "@/components/SubmitButton";
import { fullTime, sourceOf, timeAgo } from "@/lib/sources";
import { confirmPlace, fileItem, ignoreItem, retryItem, unfileItem } from "./actions";

export const dynamic = "force-dynamic";

const TABS: { id: IntakeFilter; label: string }[] = [
  { id: "needs_you", label: "Needs you" },
  { id: "all", label: "All" },
  { id: "filed", label: "Filed" },
  { id: "ignored", label: "Not about a project" },
  { id: "failed", label: "Failed" },
];

const RELATION: Record<string, string> = {
  new: "New work",
  clarification: "Clarification",
  approval: "Approval",
  change: "Change",
  context: "Context",
};

const input = "rounded-lg border border-line bg-bg px-3 py-1.5 text-sm";

type Project = { id: string; name: string };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const counts = await intakeCounts();
  const filter: IntakeFilter = TABS.some((t) => t.id === show) ? (show as IntakeFilter) : counts.needs_you ? "needs_you" : "all";
  const [items, projects] = await Promise.all([
    intakeItems(filter),
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Intake</h1>
      <p className="mt-1 text-sm text-muted">
        Everything that reached ISA, and which project it went to. Filing an item saves what it means to that project&apos;s memory right away: decisions, requirements, people and who owes what. When ISA isn&apos;t sure where it goes, she asks you here. A meeting about several projects goes to each of them, and each keeps only its own part.
      </p>

      <nav aria-label="Filter" className="mt-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/inbox?show=${t.id}`}
            aria-current={filter === t.id ? "page" : undefined}
            className={`-mb-px flex-none border-b-2 px-3 py-2 text-sm ${filter === t.id ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.label}
            <span className={`ml-1.5 rounded-full px-1.5 text-xs ${t.id === "needs_you" && counts.needs_you ? "bg-warn text-surface" : "bg-hover text-muted"}`}>{counts[t.id]}</span>
          </Link>
        ))}
      </nav>

      {items.length ? (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} projects={projects} />
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-muted">
          {filter === "needs_you" ? "Nothing needs you: every item is filed." : "Nothing here yet. Send ISA to a meeting, connect email and Slack, or add a Confluence page under Sources."}
        </p>
      )}
    </div>
  );
}

function ItemRow({ item, projects }: { item: IntakeItem; projects: Project[] }) {
  const filedIds = new Set(item.projects.map((p) => p.id));
  const others = projects.filter((p) => !filedIds.has(p.id));
  return (
    <li className={`rounded-xl border bg-surface p-4 ${item.status === "unsure" ? "border-warn/60" : "border-line"}`}>
      <div className="flex items-start gap-3">
        <SourceMark source={item.source} failed={item.status === "failed"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 font-medium">
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {item.title}
                </a>
              ) : (
                item.title
              )}
            </p>
            <Status item={item} />
          </div>
          <p className="text-xs text-muted" title={fullTime(item.at)}>
            {sourceOf(item.source).label}
            {item.author ? ` · ${item.author.replace(/\s*<[^>]*>/, "")}` : ""} · {timeAgo(item.at)}
          </p>

          {item.projects.length ? (
            <ul className="mt-3 space-y-1.5">
              {item.projects.map((p) => (
                <li key={p.id} className="flex items-start gap-2 rounded-lg bg-bg px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <Link href={`/?c=${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-xs text-muted"> · {RELATION[p.relation] ?? p.relation}</span>
                    {p.note ? <span className="mt-0.5 block text-xs text-muted">Its part: {p.note}</span> : null}
                  </span>
                  <form action={unfileItem}>
                    <input type="hidden" name="eventId" value={item.id} />
                    <input type="hidden" name="projectId" value={p.id} />
                    <button className="text-xs text-muted hover:text-danger" title={`Take this item off ${p.name}`}>
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}

          {item.questions.map((q) => (
            <div key={q.proposalId} className="mt-3 rounded-lg bg-warn/10 p-3 text-sm">
              <p className="font-medium">{q.projectName ? `Is this about ${q.projectName}?` : "Which project is this about?"}</p>
              {q.reason ? <p className="mt-0.5 text-xs text-muted">{q.reason}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {q.projectId ? (
                  <form action={confirmPlace}>
                    <input type="hidden" name="proposalId" value={q.proposalId} />
                    <SubmitButton className="bg-accent px-3 py-1.5 text-white">Yes, {q.projectName}</SubmitButton>
                  </form>
                ) : null}
                <FileForm eventId={item.id} proposalId={q.proposalId} mode="place" projects={projects.filter((p) => p.id !== q.projectId)} label={q.projectId ? "No, file under" : "File under"} />
              </div>
            </div>
          ))}

          {item.status === "failed" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-danger">ISA could not sort this item{item.error ? `: ${item.error.slice(0, 140)}` : "."}</span>
              <form action={retryItem}>
                <input type="hidden" name="eventId" value={item.id} />
                <SubmitButton className="border border-line px-3 py-1.5">Try again</SubmitButton>
              </form>
            </div>
          ) : null}

          {item.status !== "new" && item.status !== "unsure" ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted hover:text-ink">{item.status === "ignored" ? "File it under a project" : "Change where it goes"}</summary>
              <div className="mt-2 space-y-2">
                {item.status === "sorted" && others.length ? <FileForm eventId={item.id} mode="also" projects={others} label="Also file under" withAbout /> : null}
                <FileForm eventId={item.id} mode="move" projects={projects} label={item.status === "sorted" ? "Move only to" : "File under"} />
                {item.status === "sorted" ? (
                  <form action={ignoreItem}>
                    <input type="hidden" name="eventId" value={item.id} />
                    <button className="text-xs text-muted hover:text-danger">Not about any project</button>
                  </form>
                ) : null}
              </div>
            </details>
          ) : null}
          {item.status === "unsure" ? (
            <form action={ignoreItem} className="mt-2">
              <input type="hidden" name="eventId" value={item.id} />
              <button className="text-xs text-muted hover:text-danger">Not about any project</button>
            </form>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Status({ item }: { item: IntakeItem }) {
  const s =
    item.status === "unsure"
      ? { label: "Needs you", style: "bg-warn/15 text-warn" }
      : item.status === "sorted"
        ? { label: item.projects.length > 1 ? `Filed to ${item.projects.length} projects` : "Filed", style: "bg-ok/15 text-ok" }
        : item.status === "ignored"
          ? { label: "Not about a project", style: "bg-bg text-muted" }
          : item.status === "failed"
            ? { label: "Failed", style: "bg-danger/15 text-danger" }
            : { label: "Sorting…", style: "bg-accent-soft text-accent" };
  return <span className={`flex-none rounded px-1.5 py-0.5 text-[11px] font-semibold ${s.style}`}>{s.label}</span>;
}

function FileForm({
  eventId,
  proposalId,
  mode,
  projects,
  label,
  withAbout = false,
}: {
  eventId: string;
  proposalId?: string;
  mode: "place" | "move" | "also";
  projects: Project[];
  label: string;
  withAbout?: boolean;
}) {
  return (
    <form action={fileItem} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="mode" value={mode} />
      {proposalId ? <input type="hidden" name="proposalId" value={proposalId} /> : null}
      <label className="text-xs text-muted" htmlFor={`t-${mode}-${eventId}`}>
        {label}
      </label>
      <select id={`t-${mode}-${eventId}`} name="target" required defaultValue="" className={input}>
        <option value="" disabled>
          Pick a project
        </option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {mode !== "also" ? <option value="new">A new project…</option> : null}
      </select>
      {mode !== "also" ? <input name="newProjectName" placeholder="New project name (if new)" aria-label="New project name" className={`${input} w-48`} /> : null}
      {withAbout ? <input name="about" placeholder="Which part? e.g. the API rate limits" aria-label="Which part of the item" className={`${input} min-w-0 flex-1`} /> : null}
      <SubmitButton className="border border-line px-3 py-1.5">{mode === "also" ? "Add" : "File"}</SubmitButton>
    </form>
  );
}
