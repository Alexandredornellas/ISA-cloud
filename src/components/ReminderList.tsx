import Link from "next/link";
import { agendaDays, meetingTime, type AgendaMeeting } from "@/lib/agenda";
import { dayKey, type ReminderRow } from "@/lib/reminders";
import { sourceOf } from "@/lib/sources";
import { reminderStatus, snooze } from "@/app/(app)/reminders/actions";
import type { Brief } from "@/lib/brief";
import { BeforeAfter } from "@/components/Chip";

const TONE = { danger: "text-danger", warn: "text-warn", ink: "text-ink", muted: "text-muted" } as const;

const shortDay = (d: Date) => {
  const day = new Date(`${dayKey(d)}T12:00:00Z`);
  return `${day.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${day.getUTCDate()}`;
};
const longDay = (d: Date) => new Date(`${dayKey(d)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The agenda: open promises grouped by day, one line each, with the meetings ISA will join on
 * their day. "→ Ana" is something the owner owes Ana; "← Ana" is something Ana owes the owner.
 * The exact words, the source and "Not needed" open when a row is clicked.
 */
export function ReminderList({
  reminders,
  meetings = [],
  briefs = {},
  showProject = true,
  empty = "Nothing to remember. When someone promises to send something in a meeting, email or Slack, ISA adds it here.",
}: {
  reminders: ReminderRow[];
  meetings?: AgendaMeeting[];
  /** The brief for each meeting, by meeting id. */
  briefs?: Record<string, Brief>;
  showProject?: boolean;
  empty?: string;
}) {
  const days = agendaDays(reminders, meetings);
  if (!days.length) {
    return <p className="text-sm text-muted">{empty}</p>;
  }
  return (
    <div className="space-y-5">
      {days.map((day) => (
        <section key={day.id}>
          <h3 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wider ${TONE[day.tone]}`}>
            {day.label}
            {day.reminders.length ? ` · ${day.reminders.length}` : ""}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {day.meetings.map((m) => (
              <li key={m.id} id={`meeting-${m.id}`}>
                <MeetingRow m={m} brief={briefs[m.id]} />
              </li>
            ))}
            {day.reminders.map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 px-3 py-2">
                <form action={reminderStatus} className="flex-none pt-px">
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="status" value="done" />
                  <button
                    aria-label={`${r.direction === "theirs" ? "Received" : "Mark done"}: ${r.text}`}
                    title={r.direction === "theirs" ? "Received" : "Mark done"}
                    className="block h-[18px] w-[18px] rounded-full border-2 border-line hover:border-ok hover:bg-ok/15"
                  />
                </form>
                <details className="group min-w-0 flex-1 text-sm">
                  <summary className="flex cursor-pointer list-none items-center gap-2.5">
                    <span className="line-clamp-2 min-w-0 flex-1 font-medium group-open:line-clamp-none sm:line-clamp-1">{r.text}</span>
                    {r.person ? (
                      <span
                        className={`max-w-[40%] flex-none truncate rounded-full px-2 py-px text-xs ${r.direction === "theirs" ? "bg-accent-soft text-accent" : "border border-line text-ink"}`}
                        title={r.direction === "theirs" ? `Waiting on ${r.person}` : `You owe this to ${r.person}`}
                      >
                        <span aria-hidden="true">{r.direction === "theirs" ? "← " : "→ "}</span>
                        <span className="sr-only">{r.direction === "theirs" ? "waiting on " : "for "}</span>
                        {r.person}
                      </span>
                    ) : r.direction === "theirs" ? (
                      <span className="flex-none rounded-full bg-accent-soft px-2 py-px text-xs text-accent">← waiting</span>
                    ) : null}
                    {showProject && r.projectName ? <span className="hidden flex-none text-xs text-muted lg:inline">{r.projectName}</span> : null}
                    {r.due ? (
                      <span className={`w-14 flex-none text-right text-xs tabular-nums ${day.tone === "danger" ? "font-medium text-danger" : day.tone === "warn" ? "font-medium text-warn" : "text-muted"}`}>
                        {day.tone === "warn" ? "Today" : shortDay(r.due)}
                      </span>
                    ) : null}
                  </summary>
                  <div className="mt-1.5 space-y-1 pb-1 text-xs text-muted">
                    <p>
                      {r.direction === "theirs" ? `Waiting on ${r.person ?? "someone"}` : r.person ? `You owe this to ${r.person}` : "Yours to do"}
                      {r.due ? ` · due ${longDay(r.due)}${r.dueText ? ` (“${r.dueText}”)` : ""}` : ""}
                      {r.projectName ? ` · ${r.projectName}` : ""}
                    </p>
                    {r.quote ? <p className="border-l-2 border-line pl-2 italic">“{r.quote}”</p> : null}
                    <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {r.source ? (
                        r.source.url ? (
                          <a href={r.source.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
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
                      <button form={`dismiss-${r.id}`} className="hover:text-ink hover:underline">
                        Not needed
                      </button>
                      <span className="flex items-center gap-2">
                        Snooze
                        <button form={`snooze-${r.id}`} name="days" value="1" className="rounded border border-line px-1.5 hover:bg-hover hover:text-ink">
                          until tomorrow
                        </button>
                        <button form={`snooze-${r.id}`} name="days" value="7" className="rounded border border-line px-1.5 hover:bg-hover hover:text-ink">
                          a week
                        </button>
                      </span>
                    </p>
                  </div>
                </details>
                <form id={`dismiss-${r.id}`} action={reminderStatus} className="hidden">
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="status" value="dismissed" />
                </form>
                <form id={`snooze-${r.id}`} action={snooze} className="hidden">
                  <input type="hidden" name="id" value={r.id} />
                </form>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const label = "text-[11px] font-semibold uppercase tracking-wider text-muted";

/**
 * A meeting on the agenda. With a brief it opens to what to walk in knowing: what the owner owes
 * the people in it, what they owe the owner, what is unsettled and what changed in their projects.
 */
function MeetingRow({ m, brief }: { m: AgendaMeeting; brief?: Brief }) {
  const head = (
    <>
      <span className="w-[18px] flex-none text-center text-xs text-muted" aria-hidden="true">
        ●
      </span>
      <span className="flex-none text-xs tabular-nums text-muted">{meetingTime(m.at)}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{m.title}</span>
        <span className="text-muted">
          {brief?.people.length ? ` · ${brief.people.slice(0, 3).join(", ")}${brief.people.length > 3 ? ` +${brief.people.length - 3}` : ""}` : ""}
          {m.notetaker ? " · ISA Notetaker joins" : ""}
        </span>
      </span>
      {m.platform ? <span className="hidden flex-none text-xs text-muted sm:inline">{sourceOf(m.platform).label}</span> : null}
    </>
  );
  if (!brief || !brief.points) {
    return (
      <Link href="/meetings" className="flex items-center gap-2.5 bg-bg px-3 py-2 text-sm hover:bg-hover">
        {head}
      </Link>
    );
  }
  const ask = `Brief me for the meeting "${m.title}"${brief.people.length ? ` with ${brief.people.join(", ")}` : ""}: what I owe them, what they owe me, what is unsettled, and three talking points.`;
  return (
    <details className="group bg-bg text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 hover:bg-hover">
        {head}
        <span className="flex-none rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent">
          Brief · {brief.points}
          <span className="group-open:hidden"> ▾</span>
        </span>
      </summary>
      <div className="space-y-3 border-t border-line bg-surface px-3 py-3 pl-[2.6rem]">
        {brief.youOwe.length ? (
          <section>
            <h4 className={label}>You owe</h4>
            <ul className="mt-1 space-y-0.5">
              {brief.youOwe.map((r) => (
                <li key={r.id}>
                  {r.text} <span className="text-muted">→ {r.person}{r.due ? ` · due ${shortDay(r.due)}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {brief.theyOwe.length ? (
          <section>
            <h4 className={label}>They owe you</h4>
            <ul className="mt-1 space-y-0.5">
              {brief.theyOwe.map((r) => (
                <li key={r.id}>
                  {r.text} <span className="text-muted">← {r.person}{r.due ? ` · due ${shortDay(r.due)}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {brief.toSettle.length ? (
          <section>
            <h4 className={`${label} text-danger`}>To settle</h4>
            <ul className="mt-1 space-y-0.5">
              {brief.toSettle.map((t, i) => (
                <li key={i}>
                  {t.text} <span className="text-muted">· {t.projectName}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {brief.changed.length ? (
          <section>
            <h4 className={label}>Changed lately</h4>
            <ul className="mt-1 space-y-0.5">
              {brief.changed.map((c) => (
                <li key={c.key}>
                  {c.lead ? <span className="font-medium">{c.lead} </span> : null}
                  {c.parts ? <BeforeAfter parts={c.parts} /> : c.text} <span className="text-muted">· {c.source}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Link href={`/?c=${brief.projects.length === 1 ? brief.projects[0].id : "general"}&ask=${encodeURIComponent(ask)}`} className="text-accent hover:underline">
            Ask ISA for talking points
          </Link>
          {brief.projects.map((p) => (
            <Link key={p.id} href={`/?c=${p.id}`} className="text-accent hover:underline">
              Open {p.name}
            </Link>
          ))}
        </p>
      </div>
    </details>
  );
}
