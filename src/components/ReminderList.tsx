import { bucketOf, dayKey, type Bucket, type ReminderRow } from "@/lib/reminders";
import { sourceOf } from "@/lib/sources";
import { reminderStatus } from "@/app/(app)/reminders/actions";

const BUCKETS: { id: Bucket; label: string; style: string }[] = [
  { id: "overdue", label: "Overdue", style: "text-danger" },
  { id: "today", label: "Today", style: "text-warn" },
  { id: "week", label: "Next 7 days", style: "text-ink" },
  { id: "later", label: "Later", style: "text-muted" },
  { id: "undated", label: "No date", style: "text-muted" },
];

function dueLabel(r: ReminderRow) {
  if (!r.due) return null;
  const d = new Date(`${dayKey(r.due)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return r.dueText ? `${d} (“${r.dueText}”)` : d;
}

/** Open reminders grouped by when they are due, each with who it is for and where it came from. */
export function ReminderList({ reminders, showProject = true, compact = false }: { reminders: ReminderRow[]; showProject?: boolean; compact?: boolean }) {
  if (!reminders.length) {
    return <p className="text-sm text-muted">Nothing to remember. When you promise to send something in a meeting, email or Slack, ISA adds it here.</p>;
  }
  return (
    <div className="space-y-5">
      {BUCKETS.map((b) => {
        const rows = reminders.filter((r) => bucketOf(r) === b.id);
        if (!rows.length) return null;
        return (
          <section key={b.id}>
            <h3 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wider ${b.style}`}>
              {b.label} · {rows.length}
            </h3>
            <ul className={compact ? "space-y-1" : "divide-y divide-line rounded-xl border border-line bg-surface"}>
              {rows.map((r) => (
                <li key={r.id} className={`flex items-start gap-3 ${compact ? "rounded-lg px-1 py-1.5 hover:bg-bg" : "p-3"}`}>
                  <form action={reminderStatus}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="status" value="done" />
                    <button
                      aria-label={`Mark done: ${r.text}`}
                      title="Mark done"
                      className="mt-0.5 h-[18px] w-[18px] flex-none rounded-full border-2 border-line hover:border-ok hover:bg-ok/15"
                    />
                  </form>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium">
                      {r.text}
                      {r.person ? <span className="font-normal text-muted"> · for {r.person}</span> : null}
                    </p>
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                      {r.due ? <span className={b.id === "overdue" ? "font-medium text-danger" : b.id === "today" ? "font-medium text-warn" : ""}>Due {dueLabel(r)}</span> : null}
                      {showProject && r.projectName ? <span>{r.projectName}</span> : null}
                      {r.source ? (
                        r.source.url ? (
                          <a href={r.source.url} target="_blank" rel="noreferrer" className="hover:text-ink hover:underline">
                            From {sourceOf(r.source.source).label}: {r.source.title}
                          </a>
                        ) : (
                          <span>
                            From {sourceOf(r.source.source).label}: {r.source.title}
                          </span>
                        )
                      ) : (
                        <span>Added by you</span>
                      )}
                    </p>
                    {r.quote && !compact ? <p className="mt-1 border-l-2 border-line pl-2 text-xs italic text-muted">“{r.quote}”</p> : null}
                  </div>
                  <form action={reminderStatus}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="status" value="dismissed" />
                    <button className="text-xs text-muted hover:text-ink" title="Not needed">
                      Not needed
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
