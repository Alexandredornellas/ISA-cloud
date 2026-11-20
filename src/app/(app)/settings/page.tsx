import { DEFAULT_FORMATS, KIND_NAME, ticketFormats } from "@/lib/ticket-formats";
import { SubmitButton } from "@/components/SubmitButton";
import { resetTicketFormat, saveTicketFormat } from "./actions";

export const dynamic = "force-dynamic";

const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm";

export default async function SettingsPage() {
  const formats = await ticketFormats();
  return (
    <div>
      <h1 className="text-2xl font-semibold">Ticket formats</h1>
      <p className="mt-1 text-sm text-muted">
        ISA writes every Jira ticket in these formats. Change the wording, sections or order to match your team&apos;s style.
        Text in &lt;angle brackets&gt; tells ISA what to fill in.
      </p>
      <div className="mt-5 space-y-4">
        {formats.map((f) => {
          const custom = JSON.stringify(f) !== JSON.stringify(DEFAULT_FORMATS[f.kind]);
          return (
            <details key={f.kind} className="rounded-xl border border-line bg-surface p-4">
              <summary className="cursor-pointer font-medium">
                {KIND_NAME[f.kind]}
                <span className="ml-2 text-sm font-normal text-muted">
                  Jira type {f.jiraIssueType}
                  {f.label ? `, label "${f.label}"` : ""}
                  {custom ? " · customized" : ""}
                </span>
              </summary>
              <form action={saveTicketFormat} className="mt-4 space-y-3">
                <input type="hidden" name="kind" value={f.kind} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-muted">
                    Jira issue type
                    <input name="jiraIssueType" defaultValue={f.jiraIssueType} className={`mt-1 ${input}`} />
                  </label>
                  <label className="text-sm text-muted">
                    Jira label (optional)
                    <input name="label" defaultValue={f.label ?? ""} className={`mt-1 ${input}`} />
                  </label>
                </div>
                <label className="block text-sm text-muted">
                  Description format
                  <textarea name="template" defaultValue={f.template} rows={14} className={`mt-1 font-mono ${input}`} />
                </label>
                <div className="flex gap-2">
                  <SubmitButton className="bg-accent text-white">Save</SubmitButton>
                  {custom ? (
                    <button formAction={resetTicketFormat} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
                      Reset to default
                    </button>
                  ) : null}
                </div>
              </form>
            </details>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted">
        The Jira issue type must exist in your Jira project. Spikes and testing tasks are created as Tasks with a label,
        since Jira has no such types by default.
      </p>
    </div>
  );
}
