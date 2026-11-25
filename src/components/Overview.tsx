import Link from "next/link";
import type { ProjectHealth } from "@/lib/portfolio";
import { bucketOf, type ReminderRow } from "@/lib/reminders";
import type { ActivityEntry } from "@/lib/activity";
import { changeRows, needRows, projectLine } from "@/lib/briefing";
import { sourceOf, timeAgo } from "@/lib/sources";
import { ChangedList } from "@/components/ChangedList";
import { Chip } from "@/components/Chip";
import { Icon } from "@/components/Icon";

const DOT = { at_risk: "bg-danger", attention: "bg-warn", on_track: "bg-ok" } as const;
const SHOWN = 5;

function greeting(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: process.env.ISA_TIMEZONE || "America/Fortaleza" }).format(now));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export type MemoryStats = { meetings: number; slack: number; email: number; confluence: number; decisions: number; tickets: number; people: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Home: a briefing, not a dashboard. One line on how the day looks, the ask box, then three lists
 * of one-line rows: what needs the owner, what changed, and the projects. Detail is a click away.
 */
export function Overview({
  projects,
  reminders,
  feed,
  generalCount,
  stats,
  name,
}: {
  projects: ProjectHealth[];
  reminders: ReminderRow[];
  feed: ActivityEntry[];
  generalCount: number;
  stats: MemoryStats;
  name?: string;
}) {
  const needs = needRows(projects, generalCount);
  const changes = changeRows(feed);
  const mine = reminders.filter((r) => r.direction === "mine");
  const dueToday = mine.filter((r) => bucketOf(r) === "today").length;
  const late = mine.filter((r) => bucketOf(r) === "overdue").length;
  const summary = [
    needs.length ? `${plural(needs.length, "thing")} need${needs.length === 1 ? "s" : ""} you` : "Nothing needs you",
    dueToday ? `${dueToday} due today` : null,
    late ? `${late} overdue` : null,
  ].filter(Boolean);
  const memory = [
    plural(stats.meetings, "meeting"),
    plural(stats.slack, "Slack thread"),
    plural(stats.email, "email"),
    plural(stats.confluence, "Confluence page"),
    plural(stats.tickets, "Jira ticket"),
  ];

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl px-4 pb-10 pt-5 sm:px-8 sm:pt-7">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {greeting()}
          {name ? `, ${name.split(" ")[0]}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {summary.join(" · ")}
          {dueToday || late ? (
            <>
              {" · "}
              <Link href="/reminders" className="text-accent hover:underline">
                Open agenda
              </Link>
            </>
          ) : null}
        </p>
      </header>

      <section aria-label="Ask your project memory" className="mt-5">
        <form action="/" className="flex items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-3.5 pr-1.5 shadow-sm focus-within:border-accent">
          <input type="hidden" name="c" value="general" />
          <input type="hidden" name="send" value="1" />
          <Icon name="search" className="h-4 w-4 flex-none text-muted" />
          <input
            name="ask"
            required
            autoComplete="off"
            aria-label="Ask your project memory"
            placeholder="Ask anything: why we decided something, who knows what, what changed…"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
          />
          <button className="flex-none rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white">Ask</button>
        </form>
        <p className="mt-2 px-1 text-xs text-muted">
          In memory: {memory.join(" · ")} ·{" "}
          <Link href="/connections" className="hover:text-ink hover:underline">
            Add sources
          </Link>
        </p>
      </section>

      <section className="mt-7" aria-label="Needs you">
        <h2 className="mb-2 text-sm font-semibold">
          Needs you <span className="font-normal text-muted">{needs.length}</span>
        </h2>
        {needs.length ? (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <ul className="divide-y divide-line">
              {needs.slice(0, SHOWN).map((n) => (
                <li key={n.key}>
                  <NeedLink n={n} />
                </li>
              ))}
            </ul>
            {needs.length > SHOWN ? (
              <details className="border-t border-line">
                <summary className="cursor-pointer list-none px-3 py-2 text-xs text-accent hover:underline sm:px-4">Show {needs.length - SHOWN} more</summary>
                <ul className="divide-y divide-line border-t border-line">
                  {needs.slice(SHOWN).map((n) => (
                    <li key={n.key}>
                      <NeedLink n={n} />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
            <span className="h-2 w-2 rounded-full bg-ok" aria-hidden="true" /> Jira matches what was agreed, nothing is overdue, and no draft waits for you.
          </p>
        )}
      </section>

      <section className="mt-7" aria-label="Changed in your projects">
        <h2 className="mb-2 flex items-baseline justify-between text-sm font-semibold">
          <span>
            Changed <span className="font-normal text-muted">in your projects</span>
          </span>
          <Link href="/inbox" className="text-xs font-normal text-accent hover:underline">
            Everything ISA picked up
          </Link>
        </h2>
        <ChangedList rows={changes} />
      </section>

      <section id="projects" className="mt-7 scroll-mt-4" aria-label="Projects">
        <h2 className="mb-2 text-sm font-semibold">
          Projects <span className="font-normal text-muted">{projects.length}</span>
        </h2>
        {projects.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/?c=${p.id}`} className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-bg sm:px-4" title={p.summary || undefined}>
                  <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${DOT[p.status]}`} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                  <span className={`flex-none text-xs ${p.status === "at_risk" ? "font-medium text-danger" : p.status === "attention" ? "text-warn" : "text-muted"}`}>{projectLine(p)}</span>
                  <span className="hidden w-44 flex-none truncate text-right text-xs text-muted md:inline">
                    {p.lastActivity ? `${sourceOf(p.lastActivity.source).label} · ${timeAgo(p.lastActivity.at)}` : "No activity yet"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-line p-6 text-sm text-muted">
            No projects yet. Send ISA Notetaker to a meeting, add a Confluence page, or connect email and Slack: ISA starts a project when she hears about new work.{" "}
            <Link href="/connections" className="text-accent hover:underline">
              Add sources →
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function NeedLink({ n }: { n: ReturnType<typeof needRows>[number] }) {
  return (
    <Link href={n.href} className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-bg sm:px-4">
      <Chip tone={n.tone}>{n.chip}</Chip>
      <span className="min-w-0 flex-1 truncate" title={n.text}>
        {n.text}
      </span>
      {n.project ? <span className="hidden flex-none text-xs text-muted md:inline">{n.project}</span> : null}
      <span className="flex-none text-xs text-accent">Open →</span>
    </Link>
  );
}
