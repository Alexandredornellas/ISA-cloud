import Link from "next/link";
import { notFound } from "next/navigation";
import { decisionTrail, type TrailEntry } from "@/lib/trail";
import type { RequirementVersion } from "@/lib/versions";
import { SourceMark } from "@/components/SourceMark";
import { fullTime } from "@/lib/sources";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

const KIND: Record<TrailEntry["kind"], { label: string; dot: string }> = {
  decided: { label: "Recorded", dot: "bg-ok" },
  pending: { label: "Suggested next step", dot: "bg-warn" },
  discussed: { label: "Discussed", dot: "bg-accent" },
  jira: { label: "Changed in Jira", dot: "bg-danger" },
};

export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await decisionTrail(id);
  if (!t) notFound();
  const r = t.requirement;
  const ask = `Why did we decide "${r.title}"? Who asked for it and where?`;
  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <nav className="text-sm text-muted">
        <Link href="/decisions" className="hover:text-ink hover:underline">
          Decisions
        </Link>{" "}
        ·{" "}
        <Link href={`/?c=${t.project.id}`} className="hover:text-ink hover:underline">
          {t.project.name}
        </Link>
      </nav>
      <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{r.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-bg px-2 py-0.5 text-xs font-semibold capitalize">{r.status}</span>
        {r.approvedBy ? <span className="text-muted">Approved by {r.approvedBy}</span> : null}
        {t.ticket ? (
          <a href={t.ticket.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-0.5 text-xs font-medium hover:bg-hover">
            <SourceMark source="jira" size="sm" /> {t.ticket.key}
            {t.ticket.status ? <span className="text-muted">· {t.ticket.status}</span> : null}
            <Icon name="external" className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-xs text-muted">No Jira item yet</span>
        )}
      </div>
      {r.description ? <p className="mt-4 whitespace-pre-line rounded-xl border border-line bg-surface p-4 text-sm">{r.description}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/?c=${t.project.id}&ask=${encodeURIComponent(ask)}`} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">
          <Icon name="chat" /> Ask ISA why
        </Link>
        <Link href={`/diagrams?project=${t.project.id}&requirement=${r.id}`} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-hover">
          <Icon name="flow" /> Draw it
        </Link>
        <Link
          href={`/?c=${t.project.id}&ask=${encodeURIComponent(`Write user stories with acceptance criteria (Given/When/Then) for "${r.title}", from what was agreed. Cite the sources and list what is still open.`)}`}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-hover"
        >
          <Icon name="doc" /> Write stories
        </Link>
      </div>

      <h2 className="mt-8 text-sm font-semibold">How we got here</h2>
      {t.entries.length ? (
        <ol className="mt-3 border-l-2 border-line pl-5">
          {t.entries.map((e, i) => (
            <li key={i} className="relative pb-6 last:pb-0">
              <span aria-hidden="true" className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full ring-4 ring-bg ${KIND[e.kind].dot}`} />
              <p className="text-xs text-muted">
                <span className="font-semibold text-ink">{KIND[e.kind].label}</span> · {fullTime(e.at)}
              </p>
              <p className="mt-0.5 text-sm font-medium">{e.text}</p>
              {e.reason ? <p className="mt-1 text-sm text-muted">{e.reason}</p> : null}
              {e.change?.was ? <WasNow was={e.change.was} now={e.change.now} /> : null}
              {e.sources.length ? (
                <ul className="mt-2 space-y-1.5">
                  {e.sources.map((s) => (
                    <li key={s.id} className="flex items-start gap-2 rounded-lg border border-line bg-surface p-2.5 text-sm">
                      <SourceMark source={s.source} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          {s.url ? (
                            <a href={s.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                              {s.title}
                            </a>
                          ) : (
                            <span className="font-medium">{s.title}</span>
                          )}
                          <span className="text-muted">
                            {s.author ? ` · ${s.author.replace(/\s*<[^>]*>/, "")}` : ""} · {fullTime(s.at)}
                          </span>
                        </span>
                        {s.note ? <span className="mt-0.5 block text-xs text-muted">{s.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {e.kind === "pending" ? (
                <Link href={`/?c=${t.project.id}`} className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
                  Review it in {t.project.name} →
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted">No recorded history yet: this requirement may predate ISA.</p>
      )}

      {t.versions.length ? (
        <>
          <h2 className="mt-10 text-sm font-semibold">Every version</h2>
          <p className="mt-1 text-xs text-muted">What it said, from when to when. Nothing is deleted, even what was dropped.</p>
          <ol className="mt-3 space-y-2">
            {[...t.versions].reverse().map((v) => (
              <li key={v.id}>
                <details className="group rounded-xl border border-line bg-surface">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 p-3 text-sm">
                    <span className="rounded bg-bg px-1.5 py-0.5 text-xs font-semibold">v{v.version}</span>
                    <span className="min-w-0 flex-1 font-medium">{v.title}</span>
                    <span className="rounded bg-bg px-2 py-0.5 text-xs capitalize">{v.status}</span>
                    <span className="w-full text-xs text-muted">
                      {fullTime(v.validFrom)} → {v.validTo ? fullTime(v.validTo) : "now"} · {v.changedBy === "you" ? "changed by you" : v.changedBy === "unknown" ? "changed outside ISA" : `by ${v.changedBy}`}
                    </span>
                  </summary>
                  <div className="border-t border-line p-3 text-sm">
                    {v.description ? <p className="whitespace-pre-line">{v.description}</p> : <p className="text-muted">No description.</p>}
                    {v.reason ? <p className="mt-2 text-xs text-muted">Why: {v.reason}</p> : null}
                    {v.approvedBy ? <p className="mt-1 text-xs text-muted">Approved by {v.approvedBy}</p> : null}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

/** What a step changed: the fields that differ between two versions. */
function WasNow({ was, now }: { was: RequirementVersion; now: RequirementVersion }) {
  const rows: { label: string; was: string; now: string; long?: boolean }[] = [];
  if (was.title !== now.title) rows.push({ label: "Title", was: was.title, now: now.title });
  if (was.status !== now.status) rows.push({ label: "Status", was: was.status, now: now.status });
  if (was.description !== now.description) rows.push({ label: "What it says", was: was.description || "(empty)", now: now.description || "(empty)", long: true });
  if (!rows.length) return null;
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2.5 text-sm">
      {rows.map((r) => (
        <div key={r.label}>
          <p className="text-xs font-semibold text-muted">{r.label}</p>
          <div className={r.long ? "mt-1 grid gap-2 sm:grid-cols-2" : "mt-0.5 flex flex-wrap items-baseline gap-x-2"}>
            {r.long ? (
              <>
                <div className="rounded-md bg-danger/10 p-2">
                  <span className="mb-0.5 block text-[11px] font-semibold uppercase text-muted">Was</span>
                  <p className="whitespace-pre-line text-muted line-through decoration-danger/40">{r.was}</p>
                </div>
                <div className="rounded-md bg-ok/10 p-2">
                  <span className="mb-0.5 block text-[11px] font-semibold uppercase text-muted">Now</span>
                  <p className="whitespace-pre-line">{r.now}</p>
                </div>
              </>
            ) : (
              <>
                <span className="capitalize text-muted line-through">{r.was}</span>
                <span aria-hidden="true" className="text-muted">→</span>
                <span className="font-medium capitalize">{r.now}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
