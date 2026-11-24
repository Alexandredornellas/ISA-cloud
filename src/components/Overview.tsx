import Link from "next/link";
import type { ProjectHealth, Risk } from "@/lib/portfolio";
import { bucketOf, type ReminderRow } from "@/lib/reminders";
import type { ActivityEntry } from "@/lib/activity";
import { sourceOf, timeAgo } from "@/lib/sources";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ReminderList } from "@/components/ReminderList";
import { Icon, type IconName } from "@/components/Icon";

const STATUS = {
  at_risk: { label: "At risk", pill: "bg-danger/15 text-danger", bar: "bg-danger" },
  attention: { label: "Needs attention", pill: "bg-warn/15 text-warn", bar: "bg-warn" },
  on_track: { label: "On track", pill: "bg-ok/15 text-ok", bar: "bg-ok" },
} as const;

const RISK_LABEL: Record<Risk["kind"], string> = {
  drift: "Jira out of sync",
  overdue: "Overdue",
  failed: "Failed step",
  waiting: "Waiting on you",
  no_ticket: "No ticket",
};

function greeting(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: process.env.ISA_TIMEZONE || "America/Fortaleza" }).format(now));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export type MemoryStats = { meetings: number; slack: number; email: number; confluence: number; decisions: number; tickets: number; people: number };
type RecentDecision = { id: string; title: string; projectName: string; status: string; updatedAt: Date };

const ASK_EXAMPLES = [
  "Why did we decide to add Pix to guest checkout?",
  "Who can help with PCI compliance?",
  "What did Priya ask for, and where is it in Jira?",
];

const askHref = (q: string) => `/?c=general&send=1&ask=${encodeURIComponent(q)}`;

/**
 * Home: ISA as the keeper of every project's context. Ask the memory first (Know), then what needs
 * the owner's judgment (Decide), then what to make from the context (Create).
 */
export function Overview({
  projects,
  reminders,
  feed,
  generalCount,
  stats,
  recent,
}: {
  projects: ProjectHealth[];
  reminders: ReminderRow[];
  feed: ActivityEntry[];
  generalCount: number;
  stats: MemoryStats;
  recent: RecentDecision[];
}) {
  const needsYou = projects.reduce((n, p) => n + p.needsYou, 0) + generalCount;
  const risks = projects.flatMap((p) => p.risks).sort((a, b) => order(a) - order(b));
  const conflicts = risks.filter((r) => r.kind === "drift").length;
  const soon = reminders.filter((r) => ["overdue", "today", "week"].includes(bucketOf(r)));
  const sources = [
    { n: stats.meetings, label: stats.meetings === 1 ? "meeting" : "meetings", source: "zoom" },
    { n: stats.slack, label: stats.slack === 1 ? "Slack thread" : "Slack threads", source: "slack" },
    { n: stats.email, label: stats.email === 1 ? "email" : "emails", source: "gmail" },
    { n: stats.confluence, label: stats.confluence === 1 ? "Confluence page" : "Confluence pages", source: "confluence" },
    { n: stats.tickets, label: stats.tickets === 1 ? "Jira ticket" : "Jira tickets", source: "jira" },
  ];

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="mx-auto w-full min-w-0 max-w-4xl px-4 pb-10 pt-5 sm:px-8 sm:pt-7">
        <header>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{greeting()}</h1>
          <p className="mt-1 text-sm text-muted">
            ISA keeps the context of your {projects.length} project{projects.length === 1 ? "" : "s"}: every decision, who made it, where, and who knows what.
          </p>
        </header>

        <section aria-label="Ask your project memory" className="mt-5 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5">
          <form action="/" className="flex items-center gap-2">
            <input type="hidden" name="c" value="general" />
            <input type="hidden" name="send" value="1" />
            <Icon name="search" className="h-5 w-5 flex-none text-muted" />
            <input
              name="ask"
              required
              autoComplete="off"
              aria-label="Ask your project memory"
              placeholder="Ask anything: why we decided something, who knows what, what changed…"
              className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none"
            />
            <button className="flex-none rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">Ask</button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {ASK_EXAMPLES.map((q) => (
              <Link key={q} href={askHref(q)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-accent hover:text-ink">
                {q}
              </Link>
            ))}
          </div>
          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs text-muted">
            <span className="font-medium text-ink">In memory</span>
            {sources.map((s) => (
              <span key={s.source} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: sourceOf(s.source).bg }} />
                {s.n} {s.label}
              </span>
            ))}
            <Link href="/connections" className="text-accent hover:underline">
              Add sources
            </Link>
          </p>
        </section>

        <section aria-label="What ISA does" className="mt-5 grid gap-3 sm:grid-cols-3">
          <Pillar
            title="Know"
            icon="memory"
            line="Decisions, requirements and conversations, with their sources."
            links={[
              { href: "/decisions", label: `${stats.decisions} decisions` },
              { href: "/people", label: `${stats.people} people: who knows what` },
            ]}
          />
          <Pillar
            title="Decide"
            icon="branch"
            line="Conflicts and drift between Jira and what was agreed."
            links={[
              { href: "#decide", label: `${conflicts} conflict${conflicts === 1 ? "" : "s"} to settle`, warn: conflicts > 0 },
              { href: needsYou ? "#projects" : "/?c=general", label: `${needsYou} next step${needsYou === 1 ? "" : "s"} to review`, warn: needsYou > 0 },
            ]}
          />
          <Pillar
            title="Create"
            icon="ticket"
            line="Epics, stories, diagrams and reports from the context. You approve."
            links={[
              { href: askHref("Draft an epic with user stories and acceptance criteria for the most recent agreed scope. Cite the sources."), label: "Epics and stories" },
              { href: "/diagrams", label: "Diagrams" },
              { href: "/report", label: "Status report" },
            ]}
          />
        </section>

        <section id="decide" className="mt-8 scroll-mt-4" aria-label="Needs your judgment">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Icon name="branch" className="h-4 w-4 text-warn" /> Needs your judgment <span className="font-normal text-muted">{risks.length}</span>
          </h2>
          {risks.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {risks.slice(0, 6).map((r, i) => (
                <li key={i}>
                  <Link href={`/?c=${r.projectId}`} className="flex items-start gap-3 px-4 py-2.5 text-sm hover:bg-bg">
                    <span className={`mt-0.5 flex-none rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.kind === "drift" || r.kind === "overdue" || r.kind === "failed" ? "bg-danger/15 text-danger" : "bg-warn/15 text-warn"}`}>
                      {RISK_LABEL[r.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{r.text}</span>
                      <span className="block text-xs text-muted">{r.projectName}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
              <span className="h-2 w-2 rounded-full bg-ok" aria-hidden="true" /> Nothing to settle: Jira matches what was agreed, and nothing is overdue.
            </p>
          )}
          {risks.length > 6 ? <p className="mt-1 text-xs text-muted">And {risks.length - 6} more in the projects below.</p> : null}
        </section>

        {recent.length ? (
          <section className="mt-8" aria-label="Latest decisions">
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">
              Latest decisions
              <Link href="/decisions" className="text-xs font-normal text-accent hover:underline">
                All decisions
              </Link>
            </h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {recent.map((d) => (
                <li key={d.id}>
                  <Link href={`/decisions/${d.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-bg">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{d.title}</span>
                      <span className="block text-xs text-muted">
                        {d.projectName} · {d.status} · {timeAgo(d.updatedAt)}
                      </span>
                    </span>
                    <span className="flex-none text-xs text-accent">Why? →</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section id="projects" className="mt-8 scroll-mt-4" aria-label="Projects">
          <h2 className="mb-2 text-sm font-semibold">Projects</h2>
          {projects.length ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <ProjectCard p={p} />
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

      <aside className="border-t border-line bg-surface xl:sticky xl:top-0 xl:h-screen xl:overflow-y-auto xl:border-l xl:border-t-0">
        <div className="space-y-8 p-4 sm:px-8 xl:px-4">
          <section>
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">
              To-do & waiting this week
              <Link href="/reminders" className="text-xs font-normal text-accent hover:underline">
                All
              </Link>
            </h2>
            <ReminderList reminders={soon} compact empty="Nothing due this week." />
          </section>
          <section>
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">
              Just added to memory
              <Link href="/inbox" className="text-xs font-normal text-accent hover:underline">
                Intake
              </Link>
            </h2>
            <ActivityFeed entries={feed} showProject />
          </section>
        </div>
      </aside>
    </div>
  );
}

function Pillar({ title, icon, line, links }: { title: string; icon: IconName; line: string; links: { href: string; label: string; warn?: boolean }[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon name={icon} />
        </span>
        {title}
      </p>
      <p className="mt-2 text-xs text-muted">{line}</p>
      <ul className="mt-3 space-y-1 text-sm">
        {links.map((l) => (
          <li key={l.label}>
            <Link href={l.href} className={`hover:underline ${l.warn ? "font-medium text-warn" : "text-accent"}`}>
              {l.label} →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function order(r: Risk) {
  return ["drift", "overdue", "failed", "no_ticket", "waiting"].indexOf(r.kind);
}

function ProjectCard({ p }: { p: ProjectHealth }) {
  const s = STATUS[p.status];
  const top = p.risks[0];
  return (
    <Link href={`/?c=${p.id}`} className="flex h-full overflow-hidden rounded-xl border border-line bg-surface hover:border-accent">
      <span aria-hidden="true" className={`w-1 flex-none ${s.bar}`} />
      <span className="min-w-0 flex-1 p-4">
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 font-semibold">{p.name}</span>
          <span className={`flex-none rounded px-1.5 py-0.5 text-[11px] font-semibold ${s.pill}`}>{s.label}</span>
        </span>
        {p.summary ? <span className="mt-1 block line-clamp-2 text-sm text-muted">{p.summary}</span> : null}
        <span className="mt-3 grid grid-cols-4 gap-2 text-center">
          <Metric n={p.needsYou} label="need you" warn />
          <Metric n={p.openRequirements} label="open reqs" />
          <Metric n={p.owed} label="you owe" />
          <Metric n={p.waitingOn} label="waiting on" />
        </span>
        {top ? <span className="mt-3 block border-t border-line pt-2 text-xs text-danger">{top.text}</span> : null}
        {p.lastActivity ? (
          <span className="mt-2 block truncate text-xs text-muted">
            Last: {sourceOf(p.lastActivity.source).label} · {p.lastActivity.title} · {timeAgo(p.lastActivity.at)}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function Metric({ n, label, warn = false }: { n: number; label: string; warn?: boolean }) {
  return (
    <span className="rounded-lg bg-bg px-1 py-1.5">
      <span className={`block text-base font-semibold ${warn && n ? "text-warn" : ""}`}>{n}</span>
      <span className="block text-[11px] leading-tight text-muted">{label}</span>
    </span>
  );
}
