import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { upcomingMeetings } from "@/lib/agenda";
import { openReminders, recentlyDone } from "@/lib/reminders";
import { ReminderList } from "@/components/ReminderList";
import { SubmitButton } from "@/components/SubmitButton";
import { newReminder, reminderStatus, snooze } from "./actions";
import { meetingBriefs } from "@/lib/brief";

export const dynamic = "force-dynamic";

const input = "rounded-lg border border-line bg-bg px-3 py-2 text-sm";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "mine", label: "I owe" },
  { id: "theirs", label: "Waiting on" },
] as const;

/** Agenda: what the owner owes, what others owe them, and the meetings ISA will join, by day. */
export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const filter = show === "mine" || show === "theirs" ? show : "all";
  const [open, snoozed, done, projects, meetings] = await Promise.all([
    openReminders(),
    openReminders(null, "only"),
    recentlyDone(),
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
    upcomingMeetings(),
  ]);
  const briefs = await meetingBriefs(meetings);
  const count = { all: open.length, mine: open.filter((r) => r.direction === "mine").length, theirs: open.filter((r) => r.direction === "theirs").length };
  const shown = filter === "all" ? open : open.filter((r) => r.direction === filter);

  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Agenda</h1>
        <nav aria-label="Show" className="flex gap-1 text-sm">
          {FILTERS.map((f) => (
            <Link
              key={f.id}
              href={f.id === "all" ? "/reminders" : `/reminders?show=${f.id}`}
              aria-current={filter === f.id ? "page" : undefined}
              className={`rounded-full border px-3 py-1 ${filter === f.id ? "border-ink bg-ink text-bg" : "border-line text-muted hover:text-ink"}`}
            >
              {f.label} <span className="tabular-nums">{count[f.id]}</span>
            </Link>
          ))}
        </nav>
      </div>
      <p className="mt-1 text-sm text-muted">
        What you promised (→) and what others promised you (←), picked up from your meetings, email and Slack, with a brief before each meeting. Only you see it.
      </p>

      <details className="group mt-4">
        <summary className="inline-flex cursor-pointer list-none items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm hover:bg-hover group-open:hidden">+ Add a reminder</summary>
        <form action={newReminder} className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[140px_minmax(0,1fr)_150px_150px_auto]">
          <input name="text" required aria-label="What to do" placeholder="Remind me to… e.g. Send the API docs" className={`${input} sm:col-span-5`} />
          <select name="direction" aria-label="Who owes it" className={input} defaultValue="mine">
            <option value="mine">I owe it to…</option>
            <option value="theirs">They owe me…</option>
          </select>
          <input name="person" aria-label="Person" placeholder="Person (optional)" className={input} />
          <input name="due" type="date" aria-label="Due date" className={input} />
          <select name="projectId" aria-label="Project" className={input} defaultValue="">
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <SubmitButton className="bg-accent text-white">Add</SubmitButton>
        </form>
      </details>

      <div className="mt-6">
        <ReminderList
          reminders={shown}
          meetings={filter === "all" ? meetings : []}
          briefs={briefs}
          empty={
            filter === "theirs"
              ? "Nobody owes you anything right now. When someone promises you something, ISA tracks it here."
              : filter === "mine"
                ? "Nothing to do right now. When someone asks you for something, ISA adds it here."
                : undefined
          }
        />
      </div>

      {snoozed.length ? (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-muted hover:text-ink">Snoozed · {snoozed.length}</summary>
          <ul className="mt-2 space-y-1">
            {snoozed.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-1 text-sm text-muted">
                <span className="min-w-0 truncate">
                  {r.text}
                  {r.person ? ` · ${r.direction === "theirs" ? "←" : "→"} ${r.person}` : ""}
                  {r.snoozedUntil ? ` · back ${r.snoozedUntil.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}` : ""}
                </span>
                <form action={snooze}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="days" value="0" />
                  <button className="flex-none text-xs hover:text-ink">Bring back</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {done.length ? (
        <details className={snoozed.length ? "mt-3" : "mt-8"}>
          <summary className="cursor-pointer text-sm text-muted hover:text-ink">Done this week · {done.length}</summary>
          <ul className="mt-2 space-y-1">
            {done.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-1 text-sm text-muted">
                <span className="line-through">
                  {r.text}
                  {r.person ? ` · for ${r.person}` : ""}
                </span>
                <form action={reminderStatus}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="status" value="open" />
                  <button className="text-xs hover:text-ink">Undo</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
