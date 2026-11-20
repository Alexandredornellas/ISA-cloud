"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/components/Icon";

export type PanelTab = { id: string; label: string; icon: IconName; count?: number; content: React.ReactNode };

/**
 * A project screen: the main column (what needs you, and the chat) with a side panel of tabs
 * (activity, requirements, people). The panel sits on the right on wide screens and slides
 * over on smaller ones.
 */
export function Workspace({ header, main, tabs }: { header: React.ReactNode; main: React.ReactNode; tabs: PanelTab[] }) {
  const [tab, setTab] = useState(tabs[0]?.id);
  const [open, setOpen] = useState(false);
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  const panel = (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="Project details" className="flex gap-0.5 overflow-x-auto border-b border-line px-2 pt-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={t.id === active?.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex flex-none items-center gap-1 whitespace-nowrap border-b-2 px-2 pb-2.5 pt-1 text-[13px] ${t.id === active?.id ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.label}
            {t.count ? <span className="rounded-full bg-bg px-1.5 text-xs text-muted">{t.count}</span> : null}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} aria-label="Close panel" className="ml-auto mb-2 rounded-lg p-1.5 hover:bg-hover xl:hidden">
          <Icon name="close" />
        </button>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-4">
        {active?.content}
      </div>
    </div>
  );

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 pt-5 sm:px-8 sm:pt-7">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">{header}</div>
          <div className="flex flex-none gap-1 xl:hidden">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  setOpen(true);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm hover:bg-hover"
                aria-label={`Show ${t.label}`}
              >
                <Icon name={t.icon} />
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
        {main}
      </div>

      <aside aria-label="Project details" className="hidden border-l border-line bg-surface xl:sticky xl:top-0 xl:block xl:h-screen">
        {panel}
      </aside>
      {open ? (
        <div className="fixed inset-0 z-40 xl:hidden" role="dialog" aria-modal="true" aria-label={active?.label}>
          <button type="button" aria-label="Close panel" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/40" />
          <div className="absolute inset-y-0 right-0 w-[420px] max-w-[92vw] border-l border-line bg-surface shadow-xl">{panel}</div>
        </div>
      ) : null}
    </div>
  );
}
