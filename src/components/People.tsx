import Link from "next/link";
import type { DirectoryEntry, Duty, Stakeholder, SuggestionView } from "@/lib/people";
import { SourceMark } from "@/components/SourceMark";
import { SubmitButton } from "@/components/SubmitButton";
import { timeAgo } from "@/lib/sources";
import { decideSuggestion, deleteDuty, deletePerson, editDuty, newDuty, removeStakeholder, savePersonForm } from "@/app/(app)/people/actions";

type ProjectOption = { id: string; name: string };

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
      {p ? null : (
        <input name="helps" placeholder="Can help with, comma separated, e.g. PCI, Stripe contract" aria-label="Can help with" className={`${input} sm:col-span-2`} />
      )}
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

/** One duty with an inline editor: change the words or remove it. */
function DutyItem({ duty, label }: { duty: Duty; label?: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none rounded px-1 -mx-1 hover:bg-hover" title={duty.quote ? `“${duty.quote}”` : "Edit"}>
        {label ? <span className="font-medium">{label}: </span> : null}
        {duty.text}
      </summary>
      <form action={editDuty} className="my-1.5 flex gap-1.5">
        <input type="hidden" name="id" value={duty.id} />
        <input name="text" defaultValue={duty.text} aria-label="Duty" className={`${input} py-1.5`} />
        <SubmitButton className="border border-line">Save</SubmitButton>
        <SubmitButton formAction={deleteDuty} className="border border-line text-muted">
          Remove
        </SubmitButton>
      </form>
    </details>
  );
}

/** Add one or more duties (comma separated) to a person, for a project or company-wide. */
function AddDutyForm({ personId, projects, projectId }: { personId: string; projects?: ProjectOption[]; projectId?: string }) {
  return (
    <form action={newDuty} className="mt-1.5 flex flex-wrap gap-1.5">
      <input type="hidden" name="personId" value={personId} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
      <input name="text" required placeholder={projectId ? "Another duty here, e.g. Approves budget" : "New duty, e.g. Approves budget"} aria-label="New duty" className={`${input} min-w-0 flex-1 py-1.5`} />
      {projects ? (
        <select name="projectId" aria-label="Where it applies" defaultValue="" className={`${input} w-auto py-1.5`}>
          <option value="">Company-wide</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
      <SubmitButton className="border border-line">Add</SubmitButton>
    </form>
  );
}

/** A person's duties: company-wide ones, then one line group per project. */
function DutyGroups({ duties }: { duties: Duty[] }) {
  const general = duties.filter((d) => !d.projectId);
  const byProject = new Map<string, Duty[]>();
  for (const d of duties.filter((d) => d.projectId)) byProject.set(d.projectId!, [...(byProject.get(d.projectId!) ?? []), d]);
  if (!duties.length) return <p className="mt-2 text-xs text-muted">No duties yet.</p>;
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      {general.length ? (
        <div>
          <p className="text-muted">Can help with, company-wide</p>
          <ul className="mt-0.5 flex flex-wrap gap-x-3">
            {general.map((d) => (
              <li key={d.id}>
                <DutyItem duty={d} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {[...byProject.values()].map((list) => (
        <div key={list[0].projectId}>
          <Link href={`/?c=${list[0].projectId}`} className="text-muted hover:text-ink hover:underline">
            {list[0].projectName}
          </Link>
          <ul className="mt-0.5 flex flex-wrap gap-x-3">
            {list.map((d) => (
              <li key={d.id}>
                <DutyItem duty={d} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const projectCount = (duties: Duty[]) => new Set(duties.filter((d) => d.projectId).map((d) => d.projectId)).size;

/** One person in the company directory: who they are and every duty, editable in place. */
export function PersonCard({ person, projects }: { person: DirectoryEntry; projects: ProjectOption[] }) {
  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        <Initials name={person.name} />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">
            {person.name}
            <span className="ml-2 text-xs font-normal text-muted">
              {person.duties.length} {person.duties.length === 1 ? "duty" : "duties"}
              {projectCount(person.duties) ? ` · ${projectCount(person.duties)} ${projectCount(person.duties) === 1 ? "project" : "projects"}` : ""}
            </span>
          </p>
          <p className="text-muted">{[person.title, person.team].filter(Boolean).join(" · ") || "Role not known yet"}</p>
          <DutyGroups duties={person.duties} />
          {person.notes ? <p className="mt-2 text-xs text-muted">{person.notes}</p> : null}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-ink">Add a duty or edit</summary>
            <AddDutyForm personId={person.id} projects={projects} />
            <form action={savePersonForm} className="mt-3 space-y-2">
              <input type="hidden" name="id" value={person.id} />
              <PersonFields p={person} />
              <div className="flex justify-end gap-2">
                <SubmitButton formAction={deletePerson} className="border border-line text-muted">
                  Remove person
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

/** A project's stakeholders: each person's duties on this project, editable in place. */
export function StakeholderList({ projectId, people, names }: { projectId: string; people: Stakeholder[]; names: string[] }) {
  return (
    <div>
      {people.length ? (
        <ul className="space-y-4">
          {people.map((p) => {
            const elsewhere = p.duties.filter((d) => d.projectId !== projectId);
            return (
              <li key={p.id} className="flex items-start gap-2.5 text-sm">
                <Initials name={p.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.name}</p>
                  {p.title ? <p className="truncate text-xs text-muted">{p.title}</p> : null}
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {p.here.map((d) => (
                      <li key={d.id}>
                        <DutyItem duty={d} />
                      </li>
                    ))}
                  </ul>
                  {elsewhere.length ? (
                    <p className="mt-1 text-xs text-muted" title={elsewhere.map((d) => `${d.text}${d.projectName ? ` (${d.projectName})` : ""}`).join("\n")}>
                      Also: {elsewhere.slice(0, 3).map((d) => d.text).join(" · ")}
                      {elsewhere.length > 3 ? ` +${elsewhere.length - 3}` : ""}
                    </p>
                  ) : null}
                  <details className="mt-1">
                    <summary className="cursor-pointer list-none text-xs text-muted hover:text-ink hover:underline">+ Duty</summary>
                    <AddDutyForm personId={p.id} projectId={projectId} />
                    <form action={removeStakeholder} className="mt-1">
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="personId" value={p.id} />
                      <button className="text-xs text-muted hover:text-danger">Remove from this project</button>
                    </form>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nobody yet. Add who can unblock or approve things here.</p>
      )}
      <form action={newDuty} className="mt-4 grid gap-1.5">
        <input type="hidden" name="projectId" value={projectId} />
        <input name="name" list={`people-${projectId}`} required placeholder="Name (from the directory or new)" aria-label="Stakeholder name" className={input} />
        <datalist id={`people-${projectId}`}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div className="flex gap-1.5">
          <input name="text" placeholder="Their duties here, comma separated" aria-label="Their duties on this project" className={input} />
          <SubmitButton className="border border-line">Add</SubmitButton>
        </div>
      </form>
      <Link href="/people" className="mt-3 inline-block text-xs text-muted hover:text-ink hover:underline">
        Open the company directory
      </Link>
    </div>
  );
}
