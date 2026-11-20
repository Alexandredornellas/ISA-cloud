"use client";

import { useState } from "react";
import type { Notification } from "@/lib/channels";
import { ChatPanel, type Message } from "@/components/ChatPanel";
import { NotificationCard } from "@/components/NotificationCard";

/** A channel: the "Needs you" cards pinned on top, then the conversation with ISA. */
export function ChannelView({
  projectId,
  name,
  notifications,
  messages,
  examples,
  initial,
}: {
  projectId: string | null;
  name: string;
  notifications: Notification[];
  messages: Message[];
  examples?: string[];
  initial?: string;
}) {
  const [open, setOpen] = useState<string | null>(notifications[0]?.id ?? null);
  const [replyTo, setReplyTo] = useState<{ id: string; title: string } | null>(null);

  return (
    <div className="space-y-6">
      {notifications.length ? (
        <section aria-label="Needs you" className="space-y-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-warn">Needs you · {notifications.length}</p>
          {notifications.map((n) => (
            <NotificationCard
              key={`${n.id}:${JSON.stringify(n.plan).length}`}
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
        <p className="rounded-lg bg-ok/10 px-4 py-3 text-sm text-ok">All caught up. ISA posts here when something new comes in.</p>
      ) : null}

      <ChatPanel
        key={projectId ?? "general"}
        messages={messages}
        projectId={projectId}
        examples={examples}
        initial={initial}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        placeholder={projectId ? `Ask ISA about ${name} (Enter to send, Shift+Enter for a new line)` : undefined}
      />
    </div>
  );
}
