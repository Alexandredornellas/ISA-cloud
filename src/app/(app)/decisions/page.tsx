import Link from "next/link";
import { decisionList } from "@/lib/trail";
import { timeAgo } from "@/lib/sources";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  proposed: "bg-bg text-muted",
  approved: "bg-ok/15 text-ok",
  changed: "bg-warn/15 text-warn",
  done: "bg-accent-soft text-accent",
  dropped: "bg-bg text-muted line-through",
};

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const rows = await decisionList({ query: q });
  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Decisions</h1>
      <p className="mt-1 text-sm text-muted">
        Every requirement ISA keeps, across projects. Open one to see why it is what it is: the meetings, threads, emails and pages behind it, who approved it, and its Jira item.
      </p>
      <form role="search" className="mt-5 flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search decisions, e.g. Pix, card storage, CHK-14"
          aria-label="Search decisions"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        />
        <button className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-hover">Search</button>
      </form>
      {rows.length ? (
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-surface">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/decisions/${r.id}`} className="flex items-start gap-3 px-4 py-3 text-sm hover:bg-bg">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.title}</span>
                  <span className="block text-xs text-muted">
                    {r.projectName}
                    {r.jiraIssueKey ? ` · ${r.jiraIssueKey}` : ""}
                    {r.approvedBy ? ` · approved by ${r.approvedBy}` : ""} · {timeAgo(r.updatedAt)}
                  </span>
                </span>
                <span className={`flex-none rounded px-1.5 py-0.5 text-[11px] font-semibold capitalize ${STATUS[r.status] ?? ""}`}>{r.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted">{q ? `No decision matches “${q}”. Try Ask ISA: she also searches conversations and Confluence.` : "No decisions yet. They appear as ISA files meetings, email, Slack and Confluence pages."}</p>
      )}
    </div>
  );
}
