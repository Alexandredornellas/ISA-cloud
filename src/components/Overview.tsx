import Link from "next/link";
import type { ProjectHealth, Risk } from "@/lib/portfolio";
import { bucketOf, type ReminderRow } from "@/lib/reminders";
import type { ActivityEntry } from "@/lib/activity";
import { sourceOf, timeAgo } from "@/lib/sources";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ReminderList } from "@/components/ReminderList";
import { Icon } from "@/components/Icon";

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

/** The home screen for someone holding several projects: what's at risk, what needs them, and who owes what. */
export function Overview({ projects, reminders, feed, generalCount }: { projects: ProjectHealth[]; reminders: ReminderRow[]; feed: ActivityEntry[]; generalCount: number }) {
  const atRisk = projects.filter((p) => p.status === "at_risk").length;
  const needsYou = projects.reduce((n, p) => n + p.needsYou, 0) + generalCount;
  const risks = projects.flatMap((p) => p.risks).sort((a, b) => order(a) - order(b));
  const soon = reminders.filter((r) => ["overdue", "today", "week"].includes(bucketOf(r)));
  const owedToday = reminders.filter((r) => r.direction === "mine" && ["overdue", "today"].includes(bucketOf(r))).length;

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="mx-auto w-full min-w-0 max-w-4xl px-4 pb-10 pt-5 sm:px-8 sm:pt-7">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{greeting()}</h1>
            <p className="mt-1 text-sm text-muted">
              {projects.length} project{projects.length === 1 ? "" : "s"} · <Stat n={atRisk} label="at risk" tone="danger" /> · <Stat n={needsYou} label={needsYou === 1 ? "suggestion needs you" : "suggestions need you"} tone="warn" /> ·{" "}
              <Stat n={owedToday} label="due from you today" tone="warn" />
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/report" className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-hover">
              <Icon name="doc" /> Status report
            </Link>
            <Link href="/?c=general" className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">
              <Icon name="chat" /> Ask ISA
            </Link>
          </div>
        </header>

        {risks.length ? (
          <section className="mt-6" aria-label="Needs attention">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Icon name="alert" className="h-4 w-4 text-danger" /> Needs attention <span className="font-normal text-muted">{risks.length}</span>
            </h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {risks.slice(0, 8).map((r, i) => (
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
            {risks.length > 8 ? <p className="mt-1 text-xs text-muted">And {risks.length - 8} more in the projects below.</p> : null}
          </section>
        ) : projects.length ? (
          <p className="mt-6 flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
            <span className="h-2 w-2 rounded-full bg-ok" aria-hidden="true" /> No risks right now: Jira matches what was agreed, and nothing is overdue.
          </p>
        ) : null}

        <section className="mt-8" aria-label="Projects">
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
              No projects yet. Send ISA Notetaker to a meeting, or connect email and Slack, and ISA starts a project when she hears about new work.{" "}
              <Link href="/meetings" className="text-accent hover:underline">
                Join a meeting →
              </Link>
            </div>
          )}
        </section>
      </div>

      <aside className="border-t border-line bg-surface xl:sticky xl:top-0 xl:h-screen xl:overflow-y-auto xl:border-l xl:border-t-0">
        <div className="space-y-8 p-4 sm:px-8 xl:px-4">
          <section>
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">
              Who owes what this week
              <Link href="/reminders" className="text-xs font-normal text-accent hover:underline">
                All
              </Link>
            </h2>
            <ReminderList reminders={soon} compact empty="Nothing due this week." />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Latest changes</h2>
            <ActivityFeed entries={feed} showProject />
          </section>
        </div>
      </aside>
    </div>
  );
}

function order(r: Risk) {
  return ["drift", "overdue", "failed", "no_ticket", "waiting"].indexOf(r.kind);
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "danger" | "warn" }) {
  return <span className={n ? (tone === "danger" ? "font-medium text-danger" : "font-medium text-warn") : ""}>{`${n} ${label}`}</span>;
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
