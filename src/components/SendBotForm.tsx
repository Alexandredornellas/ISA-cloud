"use client";

import { useActionState, useState } from "react";
import { sendBotToMeeting, type SendBotState } from "@/app/(app)/connections/actions";
import { SubmitButton } from "@/components/SubmitButton";

const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm";

export function SendBotForm() {
  const [state, action] = useActionState<SendBotState, FormData>(sendBotToMeeting, { ok: false, error: null });
  // datetime-local has no time zone; send the browser's local time as an ISO string.
  const [local, setLocal] = useState("");
  const iso = local ? new Date(local).toISOString() : "";

  return (
    <form action={action} className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="font-medium">Join a meeting</p>
      <input name="meetingUrl" required placeholder="Paste a Zoom, Google Meet or Teams link" aria-label="Meeting link" className={input} />
      <input name="title" placeholder="Title (optional), e.g. Weekly sync" aria-label="Meeting title" className={input} />
      <label className="block text-sm text-muted">
        Starts at (leave empty to join now)
        <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} className={`mt-1 ${input}`} />
      </label>
      <input type="hidden" name="startsAt" value={iso} />
      <div className="flex items-center gap-3">
        <SubmitButton className="bg-accent text-white">Send ISA Notetaker</SubmitButton>
        {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-ok">ISA Notetaker is on its way.</p> : null}
      </div>
      <p className="text-xs text-muted">
        It joins as &quot;ISA Notetaker&quot;, visible to everyone in the call. A minute or two after the call ends, ISA reads the transcript and posts what needs you.
      </p>
    </form>
  );
}
