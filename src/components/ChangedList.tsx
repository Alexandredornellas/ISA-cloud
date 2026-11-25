"use client";

import Link from "next/link";
import type { ChangeRow } from "@/lib/briefing";
import { isNew, markAllSeen, useSince } from "@/lib/seen";
import { fullTime, timeAgo } from "@/lib/sources";
import { BeforeAfter, Chip } from "@/components/Chip";

/**
 * What changed across the projects, one line each. Rows that arrived since the owner's last visit
 * sit on top under a "New" divider, with a dot and heavier text. The rest read as seen.
 */
export function ChangedList({ rows }: { rows: ChangeRow[] }) {
  const since = useSince();
  if (!rows.length) {
    return <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">Nothing yet. Meetings, emails, Slack messages and Jira changes show up here as ISA picks them up.</p>;
  }
  const fresh = rows.filter((r) => isNew(r.at, since));
  const seen = rows.filter((r) => !isNew(r.at, since));
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {fresh.length ? (
        <>
          <p className="flex items-center justify-between gap-3 bg-accent-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent sm:px-4">
            <span>
              New since {since ? fullTime(new Date(since)) : "your last visit"} · {fresh.length}
            </span>
            <button type="button" onClick={markAllSeen} className="normal-case tracking-normal hover:underline">
              Mark as seen
            </button>
          </p>
          <ul className="divide-y divide-line">
            {fresh.map((r) => (
              <Row key={r.key} r={r} fresh />
            ))}
          </ul>
          {seen.length ? <p className="border-y border-line bg-bg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted sm:px-4">Seen earlier</p> : null}
        </>
      ) : null}
      <ul className="divide-y divide-line">
        {seen.map((r) => (
          <Row key={r.key} r={r} fresh={false} />
        ))}
      </ul>
    </div>
  );
}

function Row({ r, fresh }: { r: ChangeRow; fresh: boolean }) {
  return (
    <li>
      <details className="group open:bg-bg">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-sm hover:bg-bg sm:px-4">
          <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${fresh ? "bg-accent" : "bg-transparent"}`} />
          <Chip tone={r.tone}>{r.chip}</Chip>
          <span className={`min-w-0 flex-1 truncate group-open:whitespace-normal ${fresh ? "font-medium" : ""}`}>
            {fresh ? <span className="sr-only">New: </span> : null}
            {r.lead ? <span className="font-semibold">{r.lead} </span> : null}
            {r.parts ? <BeforeAfter parts={r.parts} /> : <span className={r.lead ? "text-muted" : ""}>{r.text}</span>}
          </span>
          <span className="hidden flex-none text-xs text-muted md:inline">
            {[r.project, r.source].filter(Boolean).join(" · ")}
          </span>
          <time className="w-16 flex-none text-right text-xs tabular-nums text-muted" title={fullTime(new Date(r.at))}>
            {timeAgo(new Date(r.at))}
          </time>
        </summary>
        <div className="space-y-1.5 px-3 pb-3 pl-[2.1rem] text-sm text-muted sm:pl-[7.6rem] sm:pr-4">
          <p className="text-xs">
            {[r.who, r.source, r.project, fullTime(new Date(r.at))].filter(Boolean).join(" · ")}
          </p>
          {r.note && (r.parts || r.lead) ? <p>{r.note}</p> : null}
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <Link href={r.href} className="text-accent hover:underline">
              Open in {r.project || "the project"}
            </Link>
            {r.url ? (
              <a href={r.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Open in {r.source}
              </a>
            ) : null}
          </p>
        </div>
      </details>
    </li>
  );
}
