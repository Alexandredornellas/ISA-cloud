import Link from "next/link";
import { addRule, removeRule, setRequirementStatus } from "@/app/(app)/projects/[id]/actions";
import { SubmitButton } from "@/components/SubmitButton";

type Requirement = { id: string; title: string; description: string; status: string; approvedBy: string | null; jiraIssueKey: string | null; jiraStatus: string | null };

const STATUS: Record<string, { label: string; style: string }> = {
  proposed: { label: "Proposed", style: "bg-bg text-muted" },
  approved: { label: "Approved", style: "bg-ok/15 text-ok" },
  changed: { label: "Changed", style: "bg-warn/15 text-warn" },
  done: { label: "Done", style: "bg-ok/15 text-ok" },
  dropped: { label: "Dropped", style: "bg-bg text-muted line-through" },
};

const MOVES = [
  { status: "approved", label: "Mark approved" },
  { status: "done", label: "Mark done" },
  { status: "proposed", label: "Back to proposed" },
  { status: "dropped", label: "Drop" },
];

const ORDER = ["changed", "proposed", "approved", "done", "dropped"];

export function jiraUrl(key: string) {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : "#";
}

/** The project's requirements, the ones that need attention first, each with its Jira ticket. */
export function RequirementList({ requirements, projectId }: { requirements: Requirement[]; projectId: string }) {
  if (!requirements.length) return <p className="text-sm text-muted">No requirements yet. They appear here once you approve ISA&apos;s suggestions.</p>;
  const sorted = [...requirements].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  return (
    <ul className="space-y-1">
      {sorted.map((r) => {
        const s = STATUS[r.status] ?? STATUS.proposed;
        return (
          <li key={r.id}>
            <details className="group rounded-lg px-2 py-2 open:bg-bg hover:bg-bg">
              <summary className="flex cursor-pointer list-none items-start gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className={`block font-medium ${r.status === "dropped" ? "text-muted line-through" : ""}`}>{r.title}</span>
                  <span className="block text-xs text-muted">{r.jiraIssueKey ? `${r.jiraIssueKey}${r.jiraStatus ? ` · ${r.jiraStatus}` : ""}` : "No ticket yet"}</span>
                </span>
                <span className={`flex-none rounded px-1.5 py-0.5 text-xs font-medium ${s.style}`}>{s.label}</span>
              </summary>
              <div className="mt-1 space-y-1 text-sm">
                {r.jiraIssueKey ? (
                  <a href={jiraUrl(r.jiraIssueKey)} target="_blank" rel="noreferrer" className="inline-block text-xs text-accent hover:underline">
                    Open {r.jiraIssueKey} in Jira
                  </a>
                ) : null}
                {r.description ? <p className="whitespace-pre-wrap text-muted">{r.description}</p> : null}
                {r.approvedBy ? <p className="text-xs text-ok">Approved by {r.approvedBy}</p> : null}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {MOVES.filter((m) => m.status !== r.status).map((m) => (
                    <form key={m.status} action={setRequirementStatus}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={m.status} />
                      <button className="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-hover">{m.label}</button>
                    </form>
                  ))}
                  <Link
                    href={`/?c=${projectId}&ask=${encodeURIComponent(`Change the requirement "${r.title}"${r.jiraIssueKey ? ` (${r.jiraIssueKey})` : ""}: `)}`}
                    className="rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
                  >
                    Ask ISA to change it
                  </Link>
                </div>
                <p className="text-[11px] text-muted">These buttons update ISA&apos;s record only. To change the Jira ticket, ask ISA: she drafts the change for you to approve.</p>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** Who is involved, and the standing rules ISA follows for this project. */
export function PeopleAndRules({
  projectId,
  people,
  rules,
}: {
  projectId: string;
  people: { name: string; role?: string | null; email?: string | null }[];
  rules: { id: string; text: string }[];
}) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">People</h3>
        {people.length ? (
          <ul className="space-y-2">
            {people.map((p) => (
              <li key={p.name} className="flex items-center gap-2.5 text-sm">
                <span aria-hidden="true" className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                  {p.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((w) => w[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.name}</span>
                  {p.role ? <span className="block truncate text-xs text-muted">{p.role}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nobody yet.</p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Your rules for ISA</h3>
        <p className="mb-2 text-xs text-muted">ISA follows these when she sorts and drafts for this project.</p>
        {rules.length ? (
          <ul className="mb-3 space-y-1">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg px-3 py-2 text-sm">
                <span>{r.text}</span>
                <form action={removeRule}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-xs text-muted hover:text-danger">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form action={addRule} className="flex gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input name="text" placeholder="e.g. Ana approves design changes" aria-label="New rule" className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm" />
          <SubmitButton className="border border-line">Add</SubmitButton>
        </form>
      </section>
    </div>
  );
}
