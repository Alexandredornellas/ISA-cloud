"use client";

import { useActionState, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { draftStatusReport, type ReportState } from "@/app/(app)/report/actions";
import { SubmitButton } from "@/components/SubmitButton";

const AUDIENCES = [
  { id: "executive", label: "Executives", hint: "Status per project, decisions needed, dates at risk" },
  { id: "team", label: "Delivery team", hint: "What changed and why, tickets, open questions" },
  { id: "client", label: "Client or stakeholders", hint: "What was done, what's next, what we need" },
] as const;

/** Pick an audience and a scope, and ISA drafts the report for you to review and copy. */
export function ReportBuilder({ projects, initialProject }: { projects: { id: string; name: string }[]; initialProject: string }) {
  const [state, action] = useActionState<ReportState, FormData>(draftStatusReport, { report: null, error: null, audience: "executive", projectId: initialProject });
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!state.report) return;
    await navigator.clipboard.writeText(`${state.report.subject}\n\n${state.report.body}`).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-6">
      <form action={action} className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Who is it for?</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {AUDIENCES.map((a) => (
              <label key={a.id} className="flex cursor-pointer gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="audience" value={a.id} defaultChecked={a.id === state.audience} className="mt-0.5 accent-[var(--accent)]" />
                <span>
                  <span className="block font-medium">{a.label}</span>
                  <span className="block text-xs text-muted">{a.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Which projects?</span>
          <select name="projectId" defaultValue={state.projectId} className="w-full rounded-lg border border-line bg-bg px-3 py-2 sm:w-72">
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <SubmitButton className="bg-accent text-white">{state.report ? "Draft again" : "Draft the report"}</SubmitButton>
        {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      </form>

      {state.report ? (
        <article className="rounded-xl border border-line bg-surface">
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <p className="text-xs text-muted">Subject</p>
              <p className="font-medium">{state.report.subject}</p>
            </div>
            <button type="button" onClick={copy} className="flex-none rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover">
              {copied ? "Copied" : "Copy"}
            </button>
          </header>
          <div className="chat-md px-4 py-4 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.report.body}</ReactMarkdown>
          </div>
          <p className="border-t border-line px-4 py-2 text-xs text-muted">Written from ISA&apos;s records of meetings, email, Slack and Jira. Review it before you send it.</p>
        </article>
      ) : null}
    </div>
  );
}
