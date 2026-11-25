"use client";

import { useState } from "react";
import type { Notification } from "@/lib/channels";
import { ChatPanel, type Message } from "@/components/ChatPanel";
import { NotificationCard } from "@/components/NotificationCard";
import { Chip } from "@/components/Chip";

/** Something in the project that disagrees with what was agreed, or is late: one row, no card. */
export type Conflict = { chip: string; tone: "danger" | "warn"; text: string };

/** A channel: the "Needs you" cards pinned on top, then the conversation with ISA. */
export function ChannelView({
  projectId,
  name,
  notifications,
  conflicts = [],
  messages,
  examples,
  initial,
  autoSend = false,
}: {
  projectId: string | null;
  name: string;
  notifications: Notification[];
  conflicts?: Conflict[];
  messages: Message[];
  examples?: string[];
  initial?: string;
  autoSend?: boolean;
}) {
  // A single draft opens by itself. With more than one thing waiting, the list stays scannable.
  const [open, setOpen] = useState<string | null>(notifications.length === 1 && !conflicts.length ? notifications[0].id : null);
  const [replyTo, setReplyTo] = useState<{ id: string; title: string } | null>(null);

  return (
    <div className="mt-6 space-y-8">
      {notifications.length || conflicts.length ? (
        <section aria-label="Needs you" className="space-y-2.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-2 w-2 rounded-full bg-warn" aria-hidden="true" />
            Needs you
            <span className="font-normal text-muted">{notifications.length + conflicts.length}</span>
          </h2>
          {conflicts.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {conflicts.map((c, i) => (
                <li key={i} className="flex items-start gap-2.5 px-3 py-2 text-sm sm:px-4">
                  <span className="pt-px">
                    <Chip tone={c.tone}>{c.chip}</Chip>
                  </span>
                  <span className="min-w-0 flex-1">{c.text}</span>
                  <a href={`/?c=${projectId ?? "general"}&ask=${encodeURIComponent(`Help me settle this: ${c.text}`)}`} className="flex-none text-xs text-accent hover:underline">
                    Ask ISA
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {notifications.map((n) => (
            <NotificationCard
              key={`${n.id}:${n.versions.length}:${JSON.stringify(n.plan).length}`}
              n={n}
              open={open === n.id}
              onToggle={() => setOpen(open === n.id ? null : n.id)}
              onChange={() => {
                setOpen(n.id);
                setReplyTo({ id: n.id, title: n.title });
              }}
            />
          ))}
        </section>
      ) : projectId ? (
        <p className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          <span className="h-2 w-2 rounded-full bg-ok" aria-hidden="true" />
          Nothing needs you here. ISA posts a card when something new comes in.
        </p>
      ) : null}

      <section aria-label="Chat with ISA">
        <h2 className="text-sm font-semibold">Chat with ISA</h2>
        <ChatPanel
          key={`${projectId ?? "general"}:${initial ?? ""}`}
          messages={messages}
          projectId={projectId}
          examples={examples}
          initial={initial}
          autoSend={autoSend}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          placeholder={projectId ? `Ask about ${name}…` : undefined}
        />
      </section>
    </div>
  );
}
