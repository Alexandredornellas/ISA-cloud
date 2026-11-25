import Link from "next/link";
import { StakeholderList, SuggestionList } from "@/components/People";
import type { Stakeholder, SuggestionView } from "@/lib/people";
import { addRule, mergeIntoProject, removeRule, setEpic, setJiraProject, setRequirementStatus } from "@/app/(app)/projects/[id]/actions";
import { SubmitButton } from "@/components/SubmitButton";

type Requirement = {
  id: string;
  title: string;
  description: string;
  status: string;
  approvedBy: string | null;
  jiraIssueKey: string | null;
  jiraStatus: string | null;
  epic: string | null;
};

const NO_EPIC = "No epic yet";

/** Requirements grouped by epic, epics in the order they first appeared, "no epic" last. */
export function byEpic<T extends { epic: string | null }>(requirements: T[]): { epic: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of requirements) {
    const key = r.epic ?? NO_EPIC;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = [...groups].map(([epic, items]) => ({ epic, items }));
  return [...out.filter((g) => g.epic !== NO_EPIC), ...out.filter((g) => g.epic === NO_EPIC)];
}

const STATUS: Record<string, { label: string; style: string }> = {
  proposed: { label: "Proposed", style: "bg-bg text-muted" },
  approved: { label: "Approved", style: "bg-ok/15 text-ok" },
  changed: { label: "Changed", style: "bg-warn/15 text-warn" },
  done: { label: "Done", style: "bg-ok/15 text-ok" },
  dropped: { label: "Dropped", style: "bg-bg text-muted line-through" },
};

const MOVES = [
  { status: "approved", label: "Mark approved" },
  { status: "done", label: "Mark done" },
  { status: "proposed", label: "Back to proposed" },
  { status: "dropped", label: "Drop" },
];

const ORDER = ["changed", "proposed", "approved", "done", "dropped"];

export function jiraUrl(key: string) {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : "#";
}

/** The project's requirements, the ones that need attention first, each with its Jira ticket. */
export type JiraSetup = { key: string | null; fallback: string | null; choices: { key: string; name: string }[] };

/** Where this project's new tickets go when ISA can't tell, with a way to change it. */
export function JiraProjectSetting({ projectId, jira }: { projectId: string; jira: JiraSetup }) {
  const current = jira.key ?? jira.fallback;
  const name = jira.choices.find((c) => c.key === current)?.name;
  return (
    <details className="mb-3 rounded-lg border border-line bg-surface text-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2">
        <span>
          Jira project: <span className="font-semibold">{current ?? "(not set)"}</span>
          {name ? <span className="text-muted"> · {name}</span> : null}
          {jira.key ? null : <span className="text-muted"> (automatic)</span>}
        </span>
        <span className="text-xs font-medium text-accent">Change</span>
      </summary>
      <form action={setJiraProject} className="space-y-2 border-t border-line p-3">
        <input type="hidden" name="projectId" value={projectId} />
        <label className="block text-xs text-muted" htmlFor={`jira-${projectId}`}>
          ISA picks the Jira project for each new ticket from what it knows (where the related tickets and the epic live) and shows it on the card
          before you approve. This is where tickets go when it can&apos;t tell. ISA reads and searches every Jira project you can see.
        </label>
        {jira.choices.length ? (
          <select id={`jira-${projectId}`} name="key" defaultValue={jira.key ?? ""} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm">
            <option value="">Automatic{jira.fallback ? ` (now ${jira.fallback})` : ""}</option>
            {jira.choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key} · {c.name}
              </option>
            ))}
          </select>
        ) : (
          <input id={`jira-${projectId}`} name="key" defaultValue={jira.key ?? ""} placeholder={jira.fallback ?? "e.g. CHK"} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm uppercase" />
        )}
        <SubmitButton className="border border-line">Save</SubmitButton>
      </form>
    </details>
  );
}

export function RequirementList({ requirements, projectId, jira }: { requirements: Requirement[]; projectId: string; jira?: JiraSetup }) {
  const setting = jira ? <JiraProjectSetting projectId={projectId} jira={jira} /> : null;
  if (!requirements.length)
    return (
      <>
        {setting}
        <p className="text-sm text-muted">No requirements yet. They appear here once you approve ISA&apos;s suggestions.</p>
      </>
    );
  const sorted = [...requirements].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const groups = byEpic(sorted);
  const epics = groups.filter((g) => g.epic !== NO_EPIC).map((g) => g.epic);
  return (
    <>
      {setting}
      {epics.length ? (
        <nav aria-label="Epics" className="mb-3 flex flex-wrap gap-1.5">
          {groups.map((g) => (
            <a key={g.epic} href={`#epic-${slug(g.epic)}`} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs hover:bg-hover">
              {g.epic} <span className="text-muted">{g.items.filter(isOpen).length}</span>
            </a>
          ))}
        </nav>
      ) : null}
      <datalist id={`epics-${projectId}`}>
        {epics.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      {epics.length ? (
        <div className="space-y-2">
          {groups.map((g) => (
            <details key={g.epic} id={`epic-${slug(g.epic)}`} open className="group/epic">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                <span className="inline-block transition-transform group-open/epic:rotate-90">›</span>
                <span>{g.epic}</span>
                <span className="font-normal normal-case tracking-normal">
                  · {g.items.filter(isOpen).length} open of {g.items.length}
                </span>
              </summary>
              <ul className="space-y-1">{g.items.map((r) => requirementRow(r, projectId))}</ul>
            </details>
          ))}
        </div>
      ) : (
        <ul className="space-y-1">{sorted.map((r) => requirementRow(r, projectId))}</ul>
      )}
    </>
  );
}

const isOpen = (r: { status: string }) => r.status !== "done" && r.status !== "dropped";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function requirementRow(r: Requirement, projectId: string) {
  const s = STATUS[r.status] ?? STATUS.proposed;
  return (
    <li key={r.id}>
      <details className="group rounded-lg px-2 py-2 open:bg-bg hover:bg-bg">
        <summary className="flex cursor-pointer list-none items-start gap-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className={`block font-medium ${r.status === "dropped" ? "text-muted line-through" : ""}`}>{r.title}</span>
            <span className="block text-xs text-muted">{r.jiraIssueKey ? `${r.jiraIssueKey}${r.jiraStatus ? ` · ${r.jiraStatus}` : ""}` : "No ticket yet"}</span>
          </span>
          <span className={`flex-none rounded px-1.5 py-0.5 text-xs font-medium ${s.style}`}>{s.label}</span>
        </summary>
        <div className="mt-1 space-y-1 text-sm">
          <p className="flex flex-wrap gap-x-3 text-xs">
            <Link href={`/decisions/${r.id}`} className="font-medium text-accent hover:underline">
              Why? See the decision trail
            </Link>
            {r.jiraIssueKey ? (
              <a href={jiraUrl(r.jiraIssueKey)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Open {r.jiraIssueKey} in Jira
              </a>
            ) : null}
          </p>
          {r.description ? <p className="whitespace-pre-wrap text-muted">{r.description}</p> : null}
          {r.approvedBy ? <p className="text-xs text-ok">Approved by {r.approvedBy}</p> : null}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {MOVES.filter((m) => m.status !== r.status).map((m) => (
              <form key={m.status} action={setRequirementStatus}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="status" value={m.status} />
                <button className="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-hover">{m.label}</button>
              </form>
            ))}
            <Link
              href={`/?c=${projectId}&ask=${encodeURIComponent(`Change the requirement "${r.title}"${r.jiraIssueKey ? ` (${r.jiraIssueKey})` : ""}: `)}`}
              className="rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
            >
              Ask ISA to change it
            </Link>
          </div>
          <form action={setEpic} className="flex items-center gap-1.5 pt-1">
            <input type="hidden" name="id" value={r.id} />
            <label htmlFor={`epic-of-${r.id}`} className="text-xs text-muted">
              Epic
            </label>
            <input
              id={`epic-of-${r.id}`}
              name="epic"
              list={`epics-${projectId}`}
              defaultValue={r.epic ?? ""}
              placeholder="e.g. Login"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs"
            />
            <button className="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-hover">Save</button>
          </form>
          <p className="text-[11px] text-muted">These buttons update ISA&apos;s record only. To change the Jira ticket, ask ISA: she drafts the change for you to approve.</p>
        </div>
      </details>
    </li>
  );
}

/** Turn this project into an epic of a bigger one: its memory moves there and this project goes away. */
export function MergeProject({ projectId, name, others }: { projectId: string; name: string; others: { id: string; name: string }[] }) {
  if (!others.length) return null;
  return (
    <details className="mt-6 rounded-lg border border-line bg-surface text-sm">
      <summary className="cursor-pointer list-none px-3 py-2">
        Part of a bigger project? <span className="text-xs font-medium text-accent">Move it in as an epic</span>
      </summary>
      <form action={mergeIntoProject} className="space-y-2 border-t border-line p-3">
        <input type="hidden" name="projectId" value={projectId} />
        <p className="text-xs text-muted">
          Everything ISA knows about {name} (requirements and their trail, items, suggestions, reminders, people, rules, diagrams, chat) moves into the
          project you pick, with its requirements under one epic. This project is then removed. Jira is not changed.
        </p>
        <label className="block text-xs text-muted" htmlFor={`merge-to-${projectId}`}>
          Project
        </label>
        <select id={`merge-to-${projectId}`} name="targetId" required defaultValue="" className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm">
          <option value="" disabled>
            Pick a project
          </option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="block text-xs text-muted" htmlFor={`merge-epic-${projectId}`}>
          Epic name
        </label>
        <input id={`merge-epic-${projectId}`} name="epic" defaultValue={name} required className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm" />
        <SubmitButton className="border border-line">Move it in</SubmitButton>
      </form>
    </details>
  );
}

/** Who moves the project forward, what ISA noticed about people, and the owner's standing rules. */
export function PeopleAndRules({
  projectId,
  people,
  suggestions,
  names,
  rules,
}: {
  projectId: string;
  people: Stakeholder[];
  suggestions: SuggestionView[];
  names: string[];
  rules: { id: string; text: string }[];
}) {
  return (
    <div className="space-y-6">
      {suggestions.length ? (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">ISA noticed · {suggestions.length}</h3>
          <SuggestionList suggestions={suggestions} showProject={false} />
        </section>
      ) : null}
      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Who moves it forward</h3>
        <p className="mb-2 text-xs text-muted">The people who decide, approve or unblock this project.</p>
        <StakeholderList projectId={projectId} people={people} names={names} />
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Your rules for ISA</h3>
        <p className="mb-2 text-xs text-muted">ISA follows these when she sorts and drafts for this project.</p>
        {rules.length ? (
          <ul className="mb-3 space-y-1">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg px-3 py-2 text-sm">
                <span>{r.text}</span>
                <form action={removeRule}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-xs text-muted hover:text-danger">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form action={addRule} className="flex gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input name="text" placeholder="e.g. Ana approves design changes" aria-label="New rule" className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm" />
          <SubmitButton className="border border-line">Add</SubmitButton>
        </form>
      </section>
    </div>
  );
}
