"use client";

import { useState, useTransition } from "react";
import { describeAction, type Action } from "@/lib/plan";
import type { Notification } from "@/lib/channels";
import { dismissNotification, moveCardToJiraProject, pickCardVersion, placeNotification, proceedNotification, retryProposal } from "@/app/(app)/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { QuestionCard } from "@/components/QuestionCard";
import { SourceMark } from "@/components/SourceMark";
import { SOURCES, sourceOf, timeAgo } from "@/lib/sources";
import { diffWords, type DiffPart } from "@/lib/diff";

const KIND = { update: "Change", new_project: "New project", clarify: "Unclear" } as const;

const time = (d: Date) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const SOURCE = SOURCES;

/** The text a step would send or write, shown under it so the owner knows exactly what happens. */
function stepDetail(a: Action): string | null {
  switch (a.type) {
    case "jira_create":
      return a.description;
    case "jira_update":
      return a.description;
    case "jira_comment":
      return a.body;
    case "jira_close":
      return null;
    case "slack_message":
      return a.text;
    case "email":
      return `${a.subject}\n\n${a.body}`;
  }
}

const label = "text-xs font-semibold uppercase tracking-wide text-muted";
const option = (on: boolean) =>
  `flex cursor-pointer items-start gap-3 rounded-lg border bg-surface p-3 ${on ? "border-accent" : "border-line"}`;

/**
 * One "Needs you" card: what happened, who said it and where, and what ISA suggests. It stays
 * in the channel until the owner does it, changes it with ISA, or marks it not needed.
 */
export function NotificationCard({
  n,
  open,
  onToggle,
  onChange,
}: {
  n: Notification;
  open: boolean;
  onToggle: () => void;
  onChange: () => void;
}) {
  const actions = n.plan.actions;
  const [kept, setKept] = useState<boolean[]>(() => actions.map(() => true));
  const epicAction = actions.find((a) => a.type === "jira_create" && a.kind === "epic") as Extract<Action, { type: "jira_create" }> | undefined;
  const [epicMode, setEpicMode] = useState<"new" | "existing">("new");
  const [epicName, setEpicName] = useState(epicAction?.summary ?? "");
  const [place, setPlace] = useState(n.places[0]?.projectId ?? "new");
  // The Jira project each new ticket goes to ("" = the project's default), changeable per step.
  const [projects, setProjects] = useState<string[]>(() => actions.map((a) => (a.type === "jira_create" ? (a.jiraProject ?? "") : "")));
  const known = new Set(n.jira.projects.map((p) => p.key));
  const suggested = n.plan.newJiraProject && !known.has(n.plan.newJiraProject.key) ? n.plan.newJiraProject : null;
  const missing = (key: string) => key !== "" && n.jira.projects.length > 0 && !known.has(key);
  const waiting = actions.filter(
    (a, i) => a.type === "jira_create" && kept[i] && missing(projects[i]) && !(epicMode === "existing" && a === epicAction),
  ).length;
  // Moving the new epic moves the tickets under it that were going to the same place.
  const setProject = (i: number, key: string) =>
    setProjects((ps) => {
      const a = actions[i];
      const followers = new Set(
        a === epicAction ? actions.flatMap((b, j) => (b.type === "jira_create" && b.epicRef === epicAction.requirementRef && ps[j] === ps[i] ? [j] : [])) : [],
      );
      return ps.map((v, j) => (j === i || followers.has(j) ? key : v));
    });
  // The header names the latest source; a card that grew with new items says so.
  const first = n.sources.at(-1);
  const more = n.sources.length - 1;
  const src = sourceOf(first?.source ?? "manual");
  const epicIndex = epicAction ? actions.indexOf(epicAction) : -1;
  const chosen = kept.filter((v, i) => v && !(epicMode === "existing" && i === epicIndex)).length;
  const failed = n.status === "failed";

  const proceedLabel = epicAction
    ? epicMode === "new"
      ? `Create epic and ${chosen} of ${actions.length} steps`
      : `Do ${chosen} ${chosen === 1 ? "step" : "steps"} under the existing epic`
    : chosen === actions.length
      ? `Do it (${chosen} ${chosen === 1 ? "step" : "steps"})`
      : `Do ${chosen} of ${actions.length} steps`;

  // Where a ticket goes, in words: the new epic by its name, or the existing epic the owner chose.
  // The Jira project is chosen under the step, so the label leaves it out.
  const stepLabel = (a: Action) => {
    if (a.type === "jira_create" && !failed) a = { ...a, jiraProject: "" };
    if (a.type !== "jira_create" || !a.epicRef || a.kind === "epic") return describeAction(a);
    const base = describeAction({ ...a, epicRef: null });
    if (/^[A-Z][A-Z0-9_]+-\d+$/.test(a.epicRef)) return `${base} (under epic ${a.epicRef})`;
    if (epicAction && a.epicRef === epicAction.requirementRef) {
      return epicMode === "existing" ? `${base} (under the existing epic)` : `${base} (under the new epic "${epicName}")`;
    }
    return base;
  };

  if (n.question) return <QuestionCard q={n.question} />;

  return (
    <article className={`rounded-xl border bg-surface transition-shadow ${open ? "border-warn/60 shadow-md" : "border-line hover:border-warn/50"}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <SourceMark source={first?.source ?? "manual"} failed={failed} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{failed ? `Something failed: ${n.title}` : n.title}</span>
          <span className="block text-sm text-muted">
            {first ? `${first.author ? `${first.author.replace(/\s*<.*>$/, "")} in ` : ""}${src.label} · ${timeAgo(first.at)}` : timeAgo(n.createdAt)}
            {more > 0 ? ` · updated, ${more + 1} sources` : ""}
          </span>
        </span>
        <span className="flex-none rounded-md bg-bg px-2 py-0.5 text-xs font-medium">
          {failed ? "Failed" : epicAction ? "New epic" : KIND[n.kind]}
        </span>
      </button>

      {open ? (
        <div className="space-y-4 px-4 pb-4 sm:pl-[3.75rem]">
          <section>
            <h3 className={label}>What happened</h3>
            <p className="mt-1 text-sm">{n.plan.summary}</p>
            {failed && n.error ? <p className="mt-2 whitespace-pre-wrap text-sm text-danger">{n.error}</p> : null}
          </section>

          {!failed && n.versions.length > 1 ? <CardVersions id={n.id} versions={n.versions} /> : null}

          {n.saved.length ? (
            <section>
              <h3 className={label}>Saved to the project&apos;s memory</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {n.saved.map((c, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span aria-hidden="true" className="mt-0.5 text-ok">✓</span>
                    <span className="min-w-0">
                      {c.op === "create" ? "New: " : c.op === "drop" ? "Dropped: " : "Updated: "}
                      {c.requirementId ? (
                        <a href={`/decisions/${c.requirementId}`} className="font-medium hover:underline">
                          {c.title}
                        </a>
                      ) : (
                        <span className="font-medium">{c.title}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {n.sources.length ? (
            <section>
              <h3 className={label}>Who said it, and where</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {n.sources.map((s) => (
                  <li key={s.id} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{SOURCE[s.source]?.label ?? s.source}</span>
                    <span className="text-muted">
                      {s.title}
                      {s.author ? ` · ${s.author.replace(/\s*<.*>$/, "")}` : ""} · {time(s.at)}
                    </span>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-accent underline">
                        Open original
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {n.kind === "clarify" ? (
            <form action={placeNotification} className="space-y-3">
              <input type="hidden" name="id" value={n.id} />
              <fieldset className="space-y-2">
                <legend className={`${label} mb-2`}>Where should this go?</legend>
                {n.places.map((p) => (
                  <label key={p.projectId} className={option(place === p.projectId)}>
                    <input type="radio" name="target" value={p.projectId} checked={place === p.projectId} onChange={() => setPlace(p.projectId)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                    <span className="text-sm font-medium">
                      {p.name}
                      {p.best ? <span className="ml-2 rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent">ISA&apos;s best guess</span> : null}
                    </span>
                  </label>
                ))}
                <label className={option(place === "new")}>
                  <input type="radio" name="target" value="new" checked={place === "new"} onChange={() => setPlace("new")} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                  <span className="flex-1 space-y-2 text-sm">
                    <span className="block font-medium">A new project</span>
                    {place === "new" ? (
                      <input name="newProjectName" aria-label="New project name" placeholder="Project name" className="w-full rounded-lg border border-line bg-bg px-3 py-2" />
                    ) : null}
                  </span>
                </label>
              </fieldset>
              <p className="text-xs text-muted">ISA files it there and drafts its tickets, choosing a new or existing epic. You approve them in that project.</p>
              <div className="flex flex-wrap gap-2">
                <SubmitButton className="bg-accent text-white">File it there</SubmitButton>
                <button type="button" onClick={onChange} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
                  Change with ISA
                </button>
                <button formAction={dismissNotification} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
                  Not needed
                </button>
              </div>
            </form>
          ) : (
            <form action={failed ? retryProposal : proceedNotification} className="space-y-4">
              <input type="hidden" name="id" value={n.id} />

              {epicAction && !failed ? (
                <fieldset className="space-y-2">
                  <legend className={`${label} mb-2`}>Epic</legend>
                  <label className={option(epicMode === "new")}>
                    <input type="radio" name="epicMode" value="new" checked={epicMode === "new"} onChange={() => setEpicMode("new")} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                    <span className="flex-1 space-y-2 text-sm">
                      <span className="block font-medium">
                        Create a new epic <span className="ml-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent">ISA suggests</span>
                      </span>
                      <input
                        name="epicName"
                        aria-label="New epic name"
                        value={epicName}
                        onChange={(e) => {
                          setEpicName(e.target.value);
                          setEpicMode("new");
                        }}
                        className="w-full rounded-lg border border-line bg-bg px-3 py-2"
                      />
                    </span>
                  </label>
                  {n.existingEpics.length ? (
                    <label className={option(epicMode === "existing")}>
                      <input type="radio" name="epicMode" value="existing" checked={epicMode === "existing"} onChange={() => setEpicMode("existing")} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                      <span className="flex-1 space-y-2 text-sm">
                        <span className="block font-medium">Put it under an existing epic</span>
                        <select name="epicKey" aria-label="Existing epic" onChange={() => setEpicMode("existing")} className="w-full rounded-lg border border-line bg-bg px-3 py-2">
                          {n.existingEpics.map((e) => (
                            <option key={e.key} value={e.key}>
                              {e.label}
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>
                  ) : null}
                </fieldset>
              ) : null}

              {suggested && !failed ? (
                <NewJiraProjectSuggestion
                  id={n.id}
                  s={suggested}
                  site={n.jira.site}
                  count={projects.filter((p) => p === suggested.key).length}
                  onMoved={(key) => setProjects((ps) => ps.map((p) => (p && (p === suggested.key || p === n.jira.fallback) ? key : p)))}
                />
              ) : null}

              {actions.length ? (
                <section>
                  <h3 className={`${label} mb-2`}>{failed ? "Steps" : n.saved.length ? "Optional next steps (only if you approve)" : "ISA suggests"}</h3>
                  <ul className="space-y-2">
                    {actions.map((a, i) => {
                      const detail = stepDetail(a);
                      const isEpic = a === epicAction;
                      const redraft = failed ? undefined : n.redraft[i];
                      if (isEpic && epicMode === "existing") return null;
                      return (
                        <li key={i} className="rounded-lg border border-line bg-surface">
                          <label className="flex cursor-pointer items-start gap-3 p-3">
                            {failed ? null : (
                              <input
                                type="checkbox"
                                name="keep"
                                value={i}
                                checked={kept[i]}
                                onChange={() => setKept((k) => k.map((v, j) => (j === i ? !v : v)))}
                                className="mt-1 h-4 w-4 flex-none accent-[var(--accent)]"
                              />
                            )}
                            <span className="min-w-0 text-sm">
                              <span className="block font-medium">
                                {isEpic ? `Create epic: ${epicName}` : stepLabel(a)}
                                {redraft === "new" ? <span className="ml-2 rounded-md bg-ok/15 px-2 py-0.5 text-xs font-medium text-ok">Added by the latest info</span> : null}
                                {redraft && redraft !== "new" ? <span className="ml-2 rounded-md bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn">Changed by the latest info</span> : null}
                              </span>
                              {a.type === "jira_update" && a.issueKey && n.current[a.issueKey] ? (
                                <TicketChange now={n.current[a.issueKey]} summary={a.summary} description={a.description} />
                              ) : redraft && redraft !== "new" && (a.type === "jira_create" || a.type === "jira_update") ? (
                                <TicketChange now={redraft} summary={a.summary} description={a.description} heading="What the latest info changed in this draft" same="Same text as before." />
                              ) : detail ? (
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-xs text-muted">Show text</summary>
                                  <p className="mt-1 whitespace-pre-wrap text-muted">{detail}</p>
                                </details>
                              ) : null}
                            </span>
                          </label>
                          {a.type === "jira_create" && !failed && kept[i] ? (
                            <JiraProjectPick
                              i={i}
                              value={projects[i]}
                              onChange={(key) => setProject(i, key)}
                              jira={n.jira}
                              suggested={suggested}
                              missing={missing(projects[i])}
                            />
                          ) : null}
                          {!failed && kept[i] ? <TicketAsks n={n} a={a} i={i} newEpicRef={epicAction?.requirementRef ?? null} /> : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              {n.plan.openQuestions.length ? (
                <section>
                  <h3 className={label}>Open questions</h3>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {n.plan.openQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {waiting && !failed ? (
                <p className="text-sm text-warn">
                  {waiting === 1 ? "1 step waits" : `${waiting} steps wait`} for a Jira project that doesn&apos;t exist yet. Create it in Jira and move them there, pick an existing project, or untick them.
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <SubmitButton className="bg-accent text-white" disabled={!failed && waiting > 0}>
                  {failed ? "Try again" : proceedLabel}
                </SubmitButton>
                {failed ? null : (
                  <button type="button" onClick={onChange} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
                    Change with ISA
                  </button>
                )}
                <button formAction={dismissNotification} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
                  {failed ? "Put aside" : "Not needed"}
                </button>
              </div>
              <p className="text-xs text-muted">
                {!failed && n.versions.length > 1 ? `This carries out version ${n.versions.at(-1)!.version}. ` : ""}This stays here until you choose. Nothing is sent before you do.
              </p>
            </form>
          )}
        </div>
      ) : null}
    </article>
  );
}

const field = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm";

const CAUSE: Record<string, string> = {
  drafted: "First draft",
  new_items: "New info",
  correction: "Your correction",
  jira_project: "Jira project",
  restored: "Went back",
};

type Version = Notification["versions"][number];

/** One version: why it changed, what changed, and the items that caused it. */
function VersionBody({ v }: { v: Version }) {
  return (
    <div className="space-y-1.5 text-sm">
      <p>{v.reason}</p>
      {v.changes.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-muted">
          {v.changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : null}
      {v.sources.length ? (
        <ul className="space-y-0.5 text-xs text-muted">
          {v.sources.map((s, i) => (
            <li key={i}>
              {SOURCE[s.source]?.label ?? s.source}: {s.title}{" "}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer" className="text-accent underline">
                  Open original
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The card's history: the latest change on top with why it happened, and every earlier version,
 * which the owner can go back to. Approving carries out the latest version shown here.
 */
function CardVersions({ id, versions }: { id: string; versions: Version[] }) {
  const latest = versions.at(-1)!;
  const earlier = versions.slice(0, -1).reverse();
  const previous = versions.at(-2)!;
  return (
    <section className="space-y-3 rounded-lg border border-line bg-bg/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={label}>Why this changed</h3>
        <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
          Version {latest.version} of {versions.length}
        </span>
        <span className="text-xs text-muted">
          {CAUSE[latest.cause] ?? latest.cause} · {timeAgo(latest.at)}
        </span>
      </div>
      <VersionBody v={latest} />
      <form action={pickCardVersion} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="version" value={previous.version} />
        <SubmitButton className="border border-line bg-surface">Undo this change (back to version {previous.version})</SubmitButton>
      </form>
      <details>
        <summary className="cursor-pointer text-sm font-medium">Earlier versions ({earlier.length})</summary>
        <ol className="mt-2 space-y-3">
          {earlier.map((v) => (
            <li key={v.version} className="space-y-2 rounded-lg border border-line bg-surface p-3">
              <p className="text-xs text-muted">
                <span className="font-semibold text-ink">Version {v.version}</span> · {CAUSE[v.cause] ?? v.cause} · {time(v.at)}
              </p>
              <p className="text-sm">{v.summary}</p>
              <VersionBody v={v} />
              <form action={pickCardVersion}>
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="version" value={v.version} />
                <SubmitButton className="border border-line bg-surface">Use version {v.version} instead</SubmitButton>
              </form>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

/** Which Jira project one new ticket goes to: ISA's choice, changeable. Field p<step>. */
function JiraProjectPick({
  i,
  value,
  onChange,
  jira,
  suggested,
  missing,
}: {
  i: number;
  value: string;
  onChange: (key: string) => void;
  jira: Notification["jira"];
  suggested: NonNullable<Notification["plan"]["newJiraProject"]> | null;
  missing: boolean;
}) {
  const listed = jira.projects.some((p) => p.key === value) || value === "" || value === suggested?.key;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-sm sm:pl-10">
      <label htmlFor={`p${i}`} className="text-muted">
        Jira project
      </label>
      <select id={`p${i}`} name={`p${i}`} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-[10rem] flex-1 rounded-lg border border-line bg-bg px-2 py-1 sm:flex-none">
        <option value="">Default{jira.fallback ? ` (${jira.fallback})` : ""}</option>
        {jira.projects.map((p) => (
          <option key={p.key} value={p.key}>
            {p.key} · {p.name}
          </option>
        ))}
        {suggested ? <option value={suggested.key}>{suggested.key} · {suggested.name} (new, not in Jira yet)</option> : null}
        {!listed ? <option value={value}>{value} (not found in Jira)</option> : null}
      </select>
      {missing ? <span className="rounded-md bg-warn/15 px-2 py-0.5 text-xs text-warn">Waiting for this project</span> : null}
    </div>
  );
}

/**
 * ISA found no Jira project that fits and suggests one. It cannot create Jira projects, so the
 * owner creates it and gives the key; the waiting steps then move there. Nothing is sent to Jira.
 */
function NewJiraProjectSuggestion({
  id,
  s,
  site,
  count,
  onMoved,
}: {
  id: string;
  s: NonNullable<Notification["plan"]["newJiraProject"]>;
  site: string | null;
  count: number;
  onMoved: (key: string) => void;
}) {
  const [key, setKey] = useState(s.key);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const move = () =>
    start(async () => {
      setError(null);
      const r = await moveCardToJiraProject(id, key);
      if (r.ok) onMoved(key.trim().toUpperCase());
      else setError(r.error);
    });
  return (
    <section className="space-y-3 rounded-lg border border-warn/50 bg-warn/5 p-3">
      <div>
        <h3 className="text-sm font-semibold">
          No Jira project fits this <span className="ml-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">ISA suggests a new one</span>
        </h3>
        <p className="mt-1 text-sm text-muted">{s.reason}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Key</dt>
        <dd className="font-mono">{s.key}</dd>
        <dt className="text-muted">Name</dt>
        <dd>{s.name}</dd>
        <dt className="text-muted">Template</dt>
        <dd>{s.template === "kanban" ? "Kanban" : "Scrum"}</dd>
      </dl>
      <p className="text-xs text-muted">
        ISA can&apos;t create Jira projects. Someone with Jira admin rights creates it
        {site ? (
          <>
            {" "}
            (
            <a href={`https://${site}/jira/projects`} target="_blank" rel="noreferrer" className="text-accent underline">
              open Jira projects
            </a>
            )
          </>
        ) : null}
        , then type the key it got and ISA moves {count === 1 ? "the step" : `the ${count} steps`} there.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Key of the new Jira project"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              move();
            }
          }}
          className="w-28 rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-sm uppercase"
        />
        <button type="button" onClick={move} disabled={busy || !key.trim()} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium disabled:opacity-60">
          {busy ? "Checking Jira…" : "It's created, move them there"}
        </button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </section>
  );
}

/**
 * The details the owner's settings say to confirm on a new ticket, filled with ISA's suggestions.
 * Field names are d<step>_<field>; "Do it" saves what is shown.
 */
function TicketAsks({ n, a, i, newEpicRef }: { n: Notification; a: Action; i: number; newEpicRef: string | null }) {
  if (a.type !== "jira_create" || a.kind === "epic") return null;
  const { asks } = n;
  const d = a.details;
  // A ticket under the epic this card creates is placed by the Epic choice above.
  const askEpic = asks.askEpic && !(newEpicRef && a.epicRef === newEpicRef);
  if (!askEpic && !asks.askSprint && !asks.askStoryPoints && !asks.askLinks && !asks.askCustom.length) return null;
  const epicNow = a.epicRef && /^[A-Z][A-Z0-9_]+-\d+$/.test(a.epicRef) ? a.epicRef : "";
  const sprints = d?.sprint && !n.sprints.includes(d.sprint) ? [d.sprint, ...n.sprints] : n.sprints;
  return (
    <div className="space-y-3 border-t border-line px-3 pb-3 pt-3 sm:pl-10">
      <p className="text-xs text-muted">
        <span className="mr-1 rounded-md bg-accent-soft px-2 py-0.5 text-accent">ISA suggests</span>
        Check these before ISA creates the ticket.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {askEpic ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Epic</span>
            <select name={`d${i}_epic`} defaultValue={epicNow} className={field}>
              <option value="">No epic</option>
              {epicNow && !n.existingEpics.some((e) => e.key === epicNow) ? <option value={epicNow}>{epicNow}</option> : null}
              {n.existingEpics.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {asks.askSprint ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Sprint</span>
            <select name={`d${i}_sprint`} defaultValue={d?.sprint ?? ""} className={field}>
              <option value="">No sprint (backlog)</option>
              {sprints.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {asks.askStoryPoints ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Story points</span>
            <input type="number" min={0} step="any" name={`d${i}_points`} defaultValue={d?.storyPoints ?? ""} placeholder="No estimate" className={field} />
          </label>
        ) : null}
        {asks.askLinks ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Linked tickets</span>
            <input name={`d${i}_links`} defaultValue={(d?.links ?? []).join(", ")} placeholder="e.g. SCRUM-4, SCRUM-9" className={field} />
          </label>
        ) : null}
        {asks.askCustom.map((name) => (
          <label key={name} className="block text-sm">
            <span className="mb-1 block font-medium">{name}</span>
            <input type="hidden" name={`d${i}_xname`} value={name} />
            <input name={`d${i}_xvalue`} defaultValue={d?.extra.find((e) => e.name.toLowerCase() === name.toLowerCase())?.value ?? ""} placeholder="Leave empty to skip" className={field} />
          </label>
        ))}
      </div>
    </div>
  );
}

/** How the ticket reads in Jira now vs after this update: removed in red and struck through, added in green. */
function TicketChange({
  now,
  summary,
  description,
  heading = "What changes in Jira",
  same = "Same as the ticket in Jira now.",
}: {
  now: { summary: string; description: string };
  summary: string | null;
  description: string | null;
  heading?: string;
  same?: string;
}) {
  const title = summary && summary !== now.summary ? diffWords(now.summary, summary) : null;
  const body = description && description !== now.description ? diffWords(now.description, description) : null;
  if (!title && !body) return <p className="mt-1 text-xs text-muted">{same}</p>;
  return (
    <details className="mt-1" open>
      <summary className="cursor-pointer text-xs text-muted">
        {heading}{" "}
        <span className="ml-1 inline-flex gap-2">
          <span className="rounded bg-danger/10 px-1 text-danger line-through">{heading === "What changes in Jira" ? "now" : "before"}</span>
          <span className="rounded bg-ok/15 px-1 text-ok">after</span>
        </span>
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-line bg-bg p-2.5">
        {title ? (
          <p className="font-medium">
            <Parts parts={title} />
          </p>
        ) : null}
        {body ? (
          <p className="max-h-96 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed">
            <Parts parts={body} />
          </p>
        ) : null}
      </div>
    </details>
  );
}

function Parts({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "same" ? (
          <span key={i} className="text-muted">
            {p.text}
          </span>
        ) : p.kind === "removed" ? (
          <del key={i} className="mr-1 rounded-sm bg-danger/10 text-danger decoration-danger/70" aria-label={`removed: ${p.text}`}>
            {p.text}
          </del>
        ) : (
          <ins key={i} className="rounded-sm bg-ok/15 text-ok no-underline" aria-label={`added: ${p.text}`}>
            {p.text}
          </ins>
        ),
      )}
    </>
  );
}
