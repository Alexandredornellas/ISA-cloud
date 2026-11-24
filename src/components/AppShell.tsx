"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import type { Channel } from "@/lib/channels";
import { Icon, type IconName } from "@/components/Icon";
import { LiveRefresh } from "@/components/LiveRefresh";

/**
 * The frame around every screen: a sidebar with Ask ISA, the projects (with what needs you in
 * each), Connections and Settings. On a phone the sidebar opens from the top bar.
 */
export function AppShell({ channels, dueReminders, peopleSuggestions = 0, intake = 0, children }: { channels: Channel[]; dueReminders: number; peopleSuggestions?: number; intake?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  const total = channels.reduce((n, c) => n + c.count, 0) + dueReminders;
  const general = channels.find((c) => !c.id);
  const projects = channels.filter((c) => c.id && !c.done);
  const done = channels.filter((c) => c.id && c.done);

  const sidebar = (
    // On a phone, following any link closes the menu.
    <nav aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)} className="flex h-full flex-col gap-1 p-3 text-sm">
      <Link href="/" className="mb-3 flex items-center gap-2 px-2 pt-1">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">I</span>
        <span className="font-semibold tracking-tight">ISA</span>
        <span className="text-xs text-muted">your project memory</span>
      </Link>

      <Item href="/" icon="grid" label="Home" count={0} match="overview" />
      <Item href="/?c=general" icon="chat" label="Ask ISA" count={general?.count ?? 0} match="general" />
      <Item href="/inbox" icon="inbox" label="Intake" count={intake} match="/inbox" />

      <Group label="Know" />
      <Item href="/decisions" icon="memory" label="Decisions" count={0} match="/decisions" />
      <Item href="/people" icon="users" label="Who knows what" count={peopleSuggestions} match="/people" />
      <Item href="/reminders" icon="bell" label="To-do & waiting" count={dueReminders} match="/reminders" />

      <Group label="Create" />
      <Item href="/diagrams" icon="flow" label="Diagrams" count={0} match="/diagrams" />
      <Item href="/report" icon="doc" label="Status report" count={0} match="/report" />

      <p className="mt-3 flex items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span>Projects</span>
        <span className="font-normal normal-case tracking-normal">{projects.length}</span>
      </p>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {projects.map((p) => (
          <Item key={p.id} href={`/?c=${p.id}`} label={p.name} count={p.count} match={p.id!} dot />
        ))}
        {projects.length === 0 ? <p className="px-2 py-1 text-muted">ISA starts a project when she hears about new work.</p> : null}
        {done.length ? (
          <details className="group pt-2">
            <summary className="cursor-pointer list-none px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-ink">
              Done · {done.length}
            </summary>
            {done.map((p) => (
              <Item key={p.id} href={`/?c=${p.id}`} label={p.name} count={0} match={p.id!} dot muted />
            ))}
          </details>
        ) : null}
      </div>

      <div className="mt-2 space-y-0.5 border-t border-line pt-2">
        <Item href="/meetings" icon="video" label="Join a meeting" count={0} match="/meetings" />
        <Item href="/connections" icon="plug" label="Sources" count={0} match="/connections" />
        <Item href="/settings" icon="gear" label="Settings" count={0} match="/settings" />
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-sidebar md:block">{sidebar}</aside>

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-sidebar/95 px-4 py-2.5 backdrop-blur md:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="-ml-1 rounded-lg p-1.5 hover:bg-hover">
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <span className="font-semibold">ISA</span>
        {total ? (
          <span className="ml-auto rounded-full bg-warn px-2 py-0.5 text-xs font-semibold text-surface">{total} need you</span>
        ) : null}
      </header>
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/40" />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-sidebar shadow-xl">
            <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-2 top-2 rounded-lg p-1.5 hover:bg-hover">
              <Icon name="close" className="h-5 w-5" />
            </button>
            {sidebar}
          </div>
        </div>
      ) : null}

      <main className="min-w-0">{children}</main>
      <LiveRefresh />
    </div>
  );
}

type ItemProps = { href: string; label: string; count: number; match: string; icon?: IconName; dot?: boolean; muted?: boolean };

/** A sidebar link. Which one is current needs the URL's query, read on the client only. */
function Item(props: ItemProps) {
  return (
    <Suspense fallback={<ItemLink {...props} active={false} />}>
      <ActiveItem {...props} />
    </Suspense>
  );
}

function ActiveItem(props: ItemProps) {
  const path = usePathname();
  const params = useSearchParams();
  const active = props.match.startsWith("/") ? path.startsWith(props.match) : path === "/" && (params.get("c") ?? (params.get("ask") ? "general" : "overview")) === props.match;
  return <ItemLink {...props} active={active} />;
}

function ItemLink({ href, label, count, active, icon, dot, muted }: ItemProps & { active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${active ? "bg-accent-soft font-medium text-ink" : muted ? "text-muted hover:bg-hover" : "text-ink hover:bg-hover"}`}
    >
      {icon ? <Icon name={icon} className="h-4 w-4 flex-none text-muted" /> : null}
      {dot ? <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${count ? "bg-warn" : muted ? "bg-ok" : "bg-line"}`} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className="inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-surface" aria-label={`${count} need you`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function Group({ label }: { label: string }) {
  return <p className="mt-3 px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>;
}
