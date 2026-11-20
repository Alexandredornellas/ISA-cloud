"use client";

import { useState } from "react";
import { describeAction, type Action } from "@/lib/plan";
import type { Notification } from "@/lib/channels";
import { dismissNotification, placeNotification, proceedNotification, retryProposal } from "@/app/(app)/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { QuestionCard } from "@/components/QuestionCard";
import { SourceMark } from "@/components/SourceMark";
import { SOURCES, sourceOf, timeAgo } from "@/lib/sources";

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
  const stepLabel = (a: Action) => {
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

              {actions.length ? (
                <section>
                  <h3 className={`${label} mb-2`}>{failed ? "Steps" : "ISA suggests"}</h3>
                  <ul className="space-y-2">
                    {actions.map((a, i) => {
                      const detail = stepDetail(a);
                      const isEpic = a === epicAction;
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
                              <span className="block font-medium">{isEpic ? `Create epic: ${epicName}` : stepLabel(a)}</span>
                              {detail ? (
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-xs text-muted">Show text</summary>
                                  <p className="mt-1 whitespace-pre-wrap text-muted">{detail}</p>
                                </details>
                              ) : null}
                            </span>
                          </label>
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

              <div className="flex flex-wrap gap-2">
                <SubmitButton className="bg-accent text-white">{failed ? "Try again" : proceedLabel}</SubmitButton>
                {failed ? null : (
                  <button type="button" onClick={onChange} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
                    Change with ISA
                  </button>
                )}
                <button formAction={dismissNotification} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
                  {failed ? "Put aside" : "Not needed"}
                </button>
              </div>
              <p className="text-xs text-muted">This stays here until you choose. Nothing is sent before you do.</p>
            </form>
          )}
        </div>
      ) : null}
    </article>
  );
}

const field = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm";

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
