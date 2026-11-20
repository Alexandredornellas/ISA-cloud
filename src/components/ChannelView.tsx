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
    <div className="mt-6 space-y-8">
      {notifications.length ? (
        <section aria-label="Needs you" className="space-y-2.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-2 w-2 rounded-full bg-warn" aria-hidden="true" />
            Needs you
            <span className="font-normal text-muted">{notifications.length}</span>
          </h2>
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
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          placeholder={projectId ? `Ask about ${name}…` : undefined}
        />
      </section>
    </div>
  );
}
