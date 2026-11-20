"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { sendChatMessage } from "@/app/(app)/chat/actions";

type Message = { id: string; role: "user" | "assistant"; text: string };

const EXAMPLES = [
  "What do we know about the login project?",
  "Make the MFA ticket support SMS codes too",
  "The billing email belongs to the Login project",
];

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

export function ChatPanel({ messages, initial = "" }: { messages: Message[]; initial?: string }) {
  const [optimistic, addOptimistic] = useOptimistic(messages, (state, text: string) => [
    ...state,
    { id: "pending", role: "user" as const, text },
  ]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function send(text: string) {
    if (!text.trim()) return;
    setError(null);
    formRef.current?.reset();
    startTransition(async () => {
      addOptimistic(text);
      const form = new FormData();
      form.set("text", text);
      const failed = await sendChatMessage(form).catch(() => "ISA could not answer.");
      if (failed) setError(failed);
    });
  }

  return (
    <div className="mt-5 space-y-4">
      {optimistic.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} onClick={() => send(e)} className="rounded-full border border-line px-3 py-1.5 text-sm text-muted hover:text-ink">
              {e}
            </button>
          ))}
        </div>
      ) : (
        <ul className="space-y-3">
          {optimistic.map((m) => (
            <li key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              <p
                className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-4 py-2.5 text-sm ${
                  m.role === "user" ? "bg-accent text-white" : "border border-line bg-surface"
                }`}
              >
                <Linked text={m.text} />
              </p>
            </li>
          ))}
          {pending ? <li className="text-sm text-muted">ISA is working…</li> : null}
        </ul>
      )}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <form
        ref={formRef}
        action={(form) => send(String(form.get("text") ?? ""))}
        className="flex gap-2 rounded-xl border border-line bg-surface p-2"
      >
        <input name="text" autoComplete="off" defaultValue={initial} autoFocus={!!initial} placeholder="Message ISA" className="flex-1 bg-transparent px-2 text-sm outline-none" />
        <button disabled={pending} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          Send
        </button>
      </form>
    </div>
  );
}
