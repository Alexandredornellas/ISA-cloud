"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sendChatMessage } from "@/app/(app)/chat/actions";

export type Message = { id: string; role: "user" | "assistant" | "log"; text: string; used?: string[] };

const EXAMPLES = [
  "What do we know about the login project?",
  "What does Jira have about MFA, and what is missing?",
  "Make the MFA ticket support SMS codes too",
  "The billing email belongs to the Login project",
];

/** ISA's answer, rendered from Markdown. */
function Answer({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Message text with web links made clickable. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="underline">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function ChatPanel({
  messages,
  initial = "",
  projectId = null,
  examples = EXAMPLES,
  replyTo = null,
  onClearReply,
  placeholder = "Ask ISA anything (Enter to send, Shift+Enter for a new line)",
}: {
  messages: Message[];
  initial?: string;
  projectId?: string | null;
  examples?: string[];
  /** The suggestion card the owner is changing with ISA, if any. */
  replyTo?: { id: string; title: string } | null;
  onClearReply?: () => void;
  placeholder?: string;
}) {
  const [optimistic, addOptimistic] = useOptimistic(messages, (state, text: string) => [
    ...state,
    { id: "pending", role: "user" as const, text },
  ]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (replyTo) boxRef.current?.focus();
  }, [replyTo]);

  function send(text: string) {
    if (!text.trim()) return;
    setError(null);
    formRef.current?.reset();
    startTransition(async () => {
      addOptimistic(text);
      const form = new FormData();
      form.set("text", text);
      if (projectId) form.set("projectId", projectId);
      if (replyTo) form.set("proposalId", replyTo.id);
      onClearReply?.();
      const failed = await sendChatMessage(form).catch(() => "ISA could not answer.");
      if (failed) setError(failed);
    });
  }

  return (
    <div className="mt-5 space-y-4">
      {optimistic.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {examples.map((e) => (
            <button key={e} onClick={() => send(e)} className="rounded-full border border-line px-3 py-1.5 text-sm text-muted hover:text-ink">
              {e}
            </button>
          ))}
        </div>
      ) : (
        <ul className="space-y-3">
          {optimistic.map((m) => (
            <li key={m.id} className={m.role === "user" ? "flex justify-end" : m.role === "log" ? "text-center" : ""}>
              {m.role === "log" ? (
                <p className="text-xs text-muted">{m.text}</p>
              ) : m.role === "user" ? (
                <p className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-accent px-4 py-2.5 text-sm text-white">
                  <Linked text={m.text} />
                </p>
              ) : (
                <div className="max-w-[85%]">
                  <div className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
                    <Answer text={m.text} />
                  </div>
                  {m.used?.length ? <p className="mt-1 px-1 text-xs text-muted">Looked at: {m.used.join(", ")}</p> : null}
                </div>
              )}
            </li>
          ))}
          {pending ? <li className="text-sm text-muted">ISA is working…</li> : null}
        </ul>
      )}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {replyTo ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          <span>Changing: {replyTo.title}</span>
          <button type="button" onClick={onClearReply} aria-label="Stop changing this suggestion" className="px-2 text-base">
            ×
          </button>
        </div>
      ) : null}
      <form
        ref={formRef}
        action={(form) => send(String(form.get("text") ?? ""))}
        className="flex gap-2 rounded-xl border border-line bg-surface p-2"
      >
        <textarea
          ref={boxRef}
          name="text"
          rows={2}
          defaultValue={initial}
          autoFocus={!!initial}
          placeholder={replyTo ? 'Tell ISA what to change, e.g. "Keep SCRUM-7 open, just comment on it"' : placeholder}
          className="flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button disabled={pending} className="self-end rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          Send
        </button>
      </form>
    </div>
  );
}
