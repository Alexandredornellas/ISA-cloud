import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { openReminders, recentlyDone } from "@/lib/reminders";
import { ReminderList } from "@/components/ReminderList";
import { SubmitButton } from "@/components/SubmitButton";
import { newReminder, reminderStatus } from "./actions";

export const dynamic = "force-dynamic";

const input = "rounded-lg border border-line bg-bg px-3 py-2 text-sm";

export default async function RemindersPage() {
  const [open, done, projects] = await Promise.all([
    openReminders(),
    recentlyDone(),
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
  ]);
  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Reminders</h1>
      <p className="mt-1 text-sm text-muted">
        What you promised to send or do, for whom and by when. ISA picks these up from your meetings, email and Slack. They are only for you: ISA never sends anything from here.
      </p>

      <form action={newReminder} className="mt-5 grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_150px_150px_auto]">
        <input name="text" required aria-label="What to do" placeholder="Remind me to… e.g. Send the API docs" className={`${input} sm:col-span-4`} />
        <input name="person" aria-label="For whom" placeholder="For whom (optional)" className={input} />
        <input name="due" type="date" aria-label="Due date" className={input} />
        <select name="projectId" aria-label="Project" className={input} defaultValue="">
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <SubmitButton className="bg-accent text-white">Add</SubmitButton>
      </form>

      <div className="mt-6">
        <ReminderList reminders={open} />
      </div>

      {done.length ? (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-muted hover:text-ink">Done this week · {done.length}</summary>
          <ul className="mt-2 space-y-1">
            {done.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-1 text-sm text-muted">
                <span className="line-through">
                  {r.text}
                  {r.person ? ` · for ${r.person}` : ""}
                </span>
                <form action={reminderStatus}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="status" value="open" />
                  <button className="text-xs hover:text-ink">Undo</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
