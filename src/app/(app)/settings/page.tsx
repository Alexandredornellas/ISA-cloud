import { DEFAULT_FORMATS, ticketFormats } from "@/lib/ticket-formats";
import { SubmitButton } from "@/components/SubmitButton";
import { resetTicketFormat, saveDraftingSettings, saveTicketFormat, startBlankAction } from "./actions";
import { blankBackups } from "@/lib/reset";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const ASKS = [
  { name: "askEpic", label: "Epic", help: "Every story, spike, bug and testing task goes under an epic: an existing one that fits, or a new epic ISA proposes with it." },
  { name: "askSprint", label: "Sprint", help: "ISA suggests one of the open sprints, or none." },
  { name: "askStoryPoints", label: "Story points", help: "ISA estimates the size from what was discussed." },
  { name: "askLinks", label: "linked tickets", help: "ISA suggests existing tickets this one relates to or depends on." },
] as const;

const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ blank?: string }> }) {
  const [formats, settings, backups, { blank }] = await Promise.all([ticketFormats(), getSettings(), blankBackups(), searchParams]);
  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Settings</h1>
      <p className="mt-1 text-sm text-muted">How ISA drafts tickets for you.</p>
      <form action={saveDraftingSettings} className="mt-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="font-semibold">Before ISA creates a ticket</h2>
        <p className="mt-1 text-sm text-muted">
          For each box you check, ISA suggests a value on every ticket she drafts, and the card asks you to confirm or change it before anything goes to Jira.
        </p>
        <label className="mt-4 block max-w-sm">
          <span className="block text-sm font-medium">Your name</span>
          <input name="ownerName" defaultValue={settings.ownerName} placeholder="e.g. Alexandre Dornellas" className={`${input} mt-1`} />
          <span className="mt-1 block text-xs text-muted">As it appears in meetings, email and Slack. ISA uses it to tell which promises are yours, for your reminders.</span>
        </label>
        <div className="mt-5 space-y-3">
          {ASKS.map((a) => (
            <label key={a.name} className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" name={a.name} defaultChecked={settings[a.name]} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
              <span>
                <span className="block font-medium">Always ask for {a.label}?</span>
                <span className="block text-sm text-muted">{a.help}</span>
              </span>
            </label>
          ))}
          {settings.askCustom.map((c) => (
            <label key={c} className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" name="askCustom" value={c} defaultChecked className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
              <span>
                <span className="block font-medium">Always ask for {c}?</span>
                <span className="block text-sm text-muted">Your own field. Uncheck and save to remove it.</span>
              </span>
            </label>
          ))}
          <label className="block">
            <span className="block text-sm font-medium">Add your own: Always ask for…</span>
            <input name="newCustom" placeholder="e.g. Component, Due date, Reviewer" className={`${input} mt-1 max-w-sm`} />
            <span className="mt-1 block text-xs text-muted">ISA suggests it on every ticket and adds your answer to the ticket&apos;s description.</span>
          </label>
        </div>
        <SubmitButton className="mt-4 border border-line">Save</SubmitButton>
      </form>
      <h2 className="mt-8 text-lg font-semibold">Ticket formats</h2>
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
                {f.name}
                <span className="ml-2 text-sm font-normal text-muted">
                  Jira type {f.jiraIssueType}
                  {f.label ? `, label "${f.label}"` : ""}
                  {custom ? " · customized" : ""}
                </span>
              </summary>
              <form action={saveTicketFormat} className="mt-4 space-y-3">
                <input type="hidden" name="kind" value={f.kind} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-sm text-muted">
                    Name
                    <input name="name" defaultValue={f.name} className={`mt-1 ${input}`} />
                  </label>
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
        Use the ticket type names exactly as your Jira shows them, e.g. &quot;Tarefa&quot; on a Portuguese site. If a type is missing,
        ISA asks you what to use instead before creating the ticket.
      </p>

      <h2 id="start-blank" className="mt-10 text-lg font-semibold">Start blank</h2>
      {blank ? (
        <p role="status" className="mt-2 rounded-lg border border-ok/40 bg-ok/10 p-3 text-sm">
          ISA&apos;s memory is empty. Everything from before is kept in the backup <code>{blank}</code>.
        </p>
      ) : null}
      <form action={startBlankAction} className="mt-3 rounded-xl border border-danger/40 bg-surface p-4">
        <p className="text-sm">
          Empties ISA&apos;s memory so you can test from scratch: projects, items, decisions and their versions, people, reminders, diagrams and
          chats. Your connections (Google, Slack, Jira), these settings and ticket formats stay. Nothing in Jira, Slack or email is touched.
        </p>
        <p className="mt-2 text-sm text-muted">A full copy is saved in the database first, so it can be restored if you ask.</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" required className="h-4 w-4" /> I want to empty ISA&apos;s memory
        </label>
        <SubmitButton className="mt-3 rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white">Start blank</SubmitButton>
        {backups.length ? <p className="mt-3 text-xs text-muted">Backups kept: {backups.join(", ")}</p> : null}
      </form>
    </div>
  );
}
