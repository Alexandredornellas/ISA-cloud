import Link from "next/link";
import type { DirectoryEntry, Stakeholder, SuggestionView } from "@/lib/people";
import { SourceMark } from "@/components/SourceMark";
import { SubmitButton } from "@/components/SubmitButton";
import { timeAgo } from "@/lib/sources";
import { addStakeholder, decideSuggestion, deletePerson, removeStakeholder, savePersonForm, setStakeholderRole } from "@/app/(app)/people/actions";

const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm";

export function Initials({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`inline-flex flex-none items-center justify-center rounded-full bg-accent-soft font-semibold text-accent ${size === "sm" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm"}`}
    >
      {letters}
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  role: "Does",
  can_help: "Can help with",
};

/** Facts ISA noticed about people, each kept only when the owner accepts it. */
export function SuggestionList({ suggestions, showProject = true }: { suggestions: SuggestionView[]; showProject?: boolean }) {
  if (!suggestions.length) return null;
  return (
    <ul className="space-y-2">
      {suggestions.map((s) => (
        <li key={s.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
          <form action={decideSuggestion} className="space-y-2">
            <input type="hidden" name="id" value={s.id} />
            <div className="flex items-start gap-2.5">
              <Initials name={s.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p>
                  <span className="font-medium">{s.name}</span>
                  {s.personId ? null : <span className="ml-1.5 rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">New</span>}
                  <span className="text-muted">
                    {" · "}
                    {s.kind === "moves_project" ? (showProject && s.projectName ? `Moves ${s.projectName} forward` : "Moves this project forward") : (KIND_LABEL[s.kind] ?? s.kind)}
                  </span>
                </p>
                <input name="text" defaultValue={s.text} aria-label={`What ISA noticed about ${s.name}`} className={`${input} mt-1.5`} />
                {s.quote ? <p className="mt-1.5 border-l-2 border-line pl-2 text-xs text-muted">“{s.quote}”</p> : null}
                {s.source ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                    <SourceMark source={s.source.source} size="sm" />
                    {s.source.url ? (
                      <a href={s.source.url} target="_blank" rel="noreferrer" className="truncate hover:text-ink hover:underline">
                        {s.source.title}
                      </a>
                    ) : (
                      <span className="truncate">{s.source.title}</span>
                    )}
                    <span className="flex-none">· {timeAgo(s.source.at)}</span>
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <SubmitButton name="decision" value="dismiss" className="border border-line text-muted">
                Not useful
              </SubmitButton>
              <SubmitButton name="decision" value="accept" className="bg-accent text-white">
                Save
              </SubmitButton>
            </div>
          </form>
        </li>
      ))}
    </ul>
  );
}

/** Fields shared by the add and edit forms. */
function PersonFields({ p }: { p?: DirectoryEntry }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <input name="name" required defaultValue={p?.name} placeholder="Name" aria-label="Name" className={input} />
      <input name="email" type="email" defaultValue={p?.email ?? ""} placeholder="Email (optional)" aria-label="Email" className={input} />
      <input name="title" defaultValue={p?.title ?? ""} placeholder="What they do, e.g. Head of Payments" aria-label="What they do" className={input} />
      <input name="team" defaultValue={p?.team ?? ""} placeholder="Team (optional)" aria-label="Team" className={input} />
      <input
        name="canHelpWith"
        defaultValue={p?.canHelpWith.join(", ") ?? ""}
        placeholder="Can help with, comma separated, e.g. PCI, Stripe contract"
        aria-label="Can help with"
        className={`${input} sm:col-span-2`}
      />
      <textarea name="notes" defaultValue={p?.notes ?? ""} rows={2} placeholder="Notes, e.g. prefers Slack, decides fast on Tuesdays" aria-label="Notes" className={`${input} sm:col-span-2`} />
    </div>
  );
}

export function AddPersonForm() {
  return (
    <details className="rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium hover:bg-hover">+ Add someone</summary>
      <form action={savePersonForm} className="space-y-2 border-t border-line p-4">
        <PersonFields />
        <div className="flex justify-end">
          <SubmitButton className="bg-accent text-white">Add to directory</SubmitButton>
        </div>
      </form>
    </details>
  );
}

/** One person in the company directory, with an inline edit form. */
export function PersonCard({ person }: { person: DirectoryEntry }) {
  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        <Initials name={person.name} />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{person.name}</p>
          <p className="text-muted">{[person.title, person.team].filter(Boolean).join(" · ") || "Role not known yet"}</p>
          {person.canHelpWith.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="text-xs text-muted">Can help with</span>
              {person.canHelpWith.map((c) => (
                <span key={c} className="rounded-full bg-bg px-2 py-0.5 text-xs">
                  {c}
                </span>
              ))}
            </div>
          ) : null}
          {person.projects.length ? (
            <ul className="mt-2 space-y-0.5 text-xs">
              {person.projects.map((p) => (
                <li key={p.id}>
                  <Link href={`/?c=${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.role ? <span className="text-muted"> · {p.role}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {person.notes ? <p className="mt-2 text-xs text-muted">{person.notes}</p> : null}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-ink">Edit</summary>
            <form action={savePersonForm} className="mt-2 space-y-2">
              <input type="hidden" name="id" value={person.id} />
              <PersonFields p={person} />
              <div className="flex justify-end gap-2">
                <SubmitButton formAction={deletePerson} className="border border-line text-muted">
                  Remove
                </SubmitButton>
                <SubmitButton className="bg-accent text-white">Save</SubmitButton>
              </div>
            </form>
          </details>
        </div>
      </div>
    </li>
  );
}

/** A project's stakeholders: who moves it forward and how, editable in place. */
export function StakeholderList({ projectId, people, names }: { projectId: string; people: Stakeholder[]; names: string[] }) {
  return (
    <div>
      {people.length ? (
        <ul className="space-y-3">
          {people.map((p) => (
            <li key={p.id} className="flex items-start gap-2.5 text-sm">
              <Initials name={p.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.name}</p>
                {p.title ? <p className="truncate text-xs text-muted">{p.title}</p> : null}
                <details className="group">
                  <summary className={`cursor-pointer list-none text-xs ${p.role ? "text-ink" : "text-muted"} hover:underline`}>{p.role ?? "+ How do they move this forward?"}</summary>
                  <form action={setStakeholderRole} className="mt-1.5 flex gap-1.5">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="personId" value={p.id} />
                    <input name="role" defaultValue={p.role ?? ""} placeholder="e.g. Approves scope changes" aria-label={`How ${p.name} moves this project forward`} className={`${input} py-1.5`} />
                    <SubmitButton className="border border-line">Save</SubmitButton>
                    <SubmitButton formAction={removeStakeholder} className="border border-line text-muted">
                      Remove
                    </SubmitButton>
                  </form>
                </details>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nobody yet. Add who can unblock or approve things here.</p>
      )}
      <form action={addStakeholder} className="mt-3 grid gap-1.5">
        <input type="hidden" name="projectId" value={projectId} />
        <input name="name" list={`people-${projectId}`} required placeholder="Name (from the directory or new)" aria-label="Stakeholder name" className={input} />
        <datalist id={`people-${projectId}`}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div className="flex gap-1.5">
          <input name="role" placeholder="How they move it forward" aria-label="How they move the project forward" className={input} />
          <SubmitButton className="border border-line">Add</SubmitButton>
        </div>
      </form>
      <Link href="/people" className="mt-3 inline-block text-xs text-muted hover:text-ink hover:underline">
        Open the company directory
      </Link>
    </div>
  );
}
