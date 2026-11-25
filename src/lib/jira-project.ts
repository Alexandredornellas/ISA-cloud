// Which Jira project each ISA project creates tickets in. Reading and search cover every Jira
// project the account can see; new tickets, epics and sprints use the project's own key, or
// JIRA_PROJECT_KEY when it has none.
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { jiraSearcher } from "@/lib/jira-research";
import type { JiraClient } from "@/lib/jira";
import type { Plan } from "@/lib/plan";
import { saveCardVersion } from "@/lib/card-versions";

export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;

export function defaultJiraKey(): string | null {
  return process.env.JIRA_PROJECT_KEY || null;
}

/**
 * The Jira project an ISA project's new tickets go to when a ticket does not say: the one the owner
 * chose, else the one most of its known tickets live in, else JIRA_PROJECT_KEY.
 */
export async function jiraKeyFor(projectId: string | null | undefined): Promise<string | null> {
  if (projectId) {
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { jiraProjectKey: true } });
    if (p?.jiraProjectKey) return p.jiraProjectKey;
    const learned = await learnedJiraKey(projectId);
    if (learned) return learned;
  }
  return defaultJiraKey();
}

/** The Jira project most of an ISA project's tickets live in, or null when it has none. */
export async function learnedJiraKey(projectId: string): Promise<string | null> {
  const [reqs, tickets] = await Promise.all([
    db.select({ key: schema.requirements.jiraIssueKey }).from(schema.requirements).where(eq(schema.requirements.projectId, projectId)),
    db.select({ key: schema.jiraTickets.key }).from(schema.jiraTickets).where(eq(schema.jiraTickets.projectId, projectId)),
  ]);
  const count = new Map<string, number>();
  for (const { key } of [...reqs, ...tickets]) {
    const prefix = key?.match(/^([A-Z][A-Z0-9_]*)-\d+$/)?.[1];
    if (prefix) count.set(prefix, (count.get(prefix) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Up to five epic titles per Jira project, from ISA's copy of the tickets: a hint of each project's scope. */
async function epicsByJiraProject(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ key: schema.jiraTickets.key, summary: schema.jiraTickets.summary, issueType: schema.jiraTickets.issueType })
    .from(schema.jiraTickets)
    .where(isNull(schema.jiraTickets.deletedAt));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!/^(epic|[eé]pico|[eé]pica|epique)$/i.test(r.issueType ?? "")) continue;
    const prefix = r.key.split("-")[0];
    const list = out.get(prefix) ?? [];
    if (list.length < 5) out.set(prefix, [...list, r.summary]);
  }
  return out;
}

/** What drafting needs to choose a Jira project per ticket, or to suggest a new one. */
export async function jiraProjectsText(projectId: string | null): Promise<string> {
  const [fallback, choices, epics] = await Promise.all([jiraKeyFor(projectId), jiraProjectChoices(), epicsByJiraProject()]);
  const line = (c: JiraProjectChoice) => {
    const e = epics.get(c.key);
    return `- ${c.key} "${c.name}"${c.description ? `: ${c.description}` : ""}${e?.length ? ` (epics: ${e.map((t) => `"${t}"`).join(", ")})` : ""}`;
  };
  return [
    `Jira projects you can create tickets in:\n${choices.length ? choices.map(line).join("\n") : "(list unavailable)"}`,
    `For each new ticket, set jiraProject to the Jira project whose scope fits the work: the same product, client or team, judging from its name, description and epics, where the related tickets or the epic live, and what the item says. ${fallback ?? "The default project"} is only the default, not a reason to choose it. A similar domain is not a fit (one game's project does not fit another game).`,
    `When none of them fits, fill newJiraProject with a project to suggest creating (a short unused key, a name, scrum or kanban, and why), and set jiraProject of this work's tickets to that key. ISA cannot create Jira projects: the owner creates it, and the tickets wait for it. Use "" when unsure; it then goes to ${fallback ?? "the default project"}.`,
  ].join("\n");
}

/** Set (or clear, with "") the Jira project an ISA project uses. Returns the saved key or an error. */
export async function setJiraKey(projectId: string, raw: string): Promise<{ ok: true; key: string | null } | { ok: false; error: string }> {
  const key = raw.trim().toUpperCase();
  if (key && !JIRA_KEY.test(key)) return { ok: false, error: `"${raw}" is not a Jira project key (like SCRUM or CHK).` };
  await db.update(schema.projects).set({ jiraProjectKey: key || null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  return { ok: true, key: key || null };
}

export type JiraProjectChoice = { key: string; name: string; description?: string };

let projectCache: { at: number; list: JiraProjectChoice[] } | null = null;

/** Jira projects to choose from (cached for five minutes, or fetched again with fresh); empty when Jira is not connected. */
export async function jiraProjectChoices(fresh = false): Promise<JiraProjectChoice[]> {
  if (!fresh && projectCache && Date.now() - projectCache.at < 300_000) return projectCache.list;
  const jira = jiraSearcher();
  if (!jira || !("listProjects" in jira)) return [];
  try {
    const list = await (jira as JiraClient).listProjects();
    projectCache = { at: Date.now(), list };
    return list;
  } catch (err) {
    console.error("jira projects failed", { error: err instanceof Error ? err.name : "unknown" });
    return [];
  }
}

/**
 * The plan with its tickets moved to `key`: those waiting for the suggested new Jira project, and
 * those going to `previous`, the ISA project's Jira project before the owner changed it. Tickets
 * on "" follow the project's setting anyway; tickets ISA sent elsewhere stay. Any suggestion of a
 * new Jira project is then settled.
 */
export function moveToJiraProject(plan: Plan, key: string, previous: string | null = null): { plan: Plan; moved: number } {
  const from = new Set([plan.newJiraProject?.key, previous].filter((k): k is string => !!k && k !== key));
  let moved = 0;
  const actions = plan.actions.map((a) => {
    if (a.type !== "jira_create" || !a.jiraProject || !from.has(a.jiraProject)) return a;
    moved++;
    return { ...a, jiraProject: key };
  });
  return { plan: { ...plan, actions, newJiraProject: null }, moved };
}

/**
 * The owner created the suggested Jira project, or chose another for an ISA project: check Jira can
 * see it, make it the ISA project's Jira project, and move the waiting suggestions' tickets that
 * were going to the old one (or waiting for the new one) there. Only ISA's drafts change; nothing is
 * sent to Jira, and no AI call is needed.
 */
export async function adoptJiraProject(
  raw: string,
  where: { proposalId: string } | { projectId: string },
): Promise<{ ok: true; key: string; moved: number } | { ok: false; error: string }> {
  const key = raw.trim().toUpperCase();
  if (!JIRA_KEY.test(key)) return { ok: false, error: `"${raw}" is not a Jira project key (like NFS8).` };
  const known = await jiraProjectChoices(true);
  if (known.length && !known.some((p) => p.key === key)) {
    return { ok: false, error: `ISA can't see a Jira project ${key} yet. Create it in Jira first, or check the key.` };
  }
  let projectId: string | null = "projectId" in where ? where.projectId : null;
  if ("proposalId" in where) {
    const p = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, where.proposalId), columns: { projectId: true } });
    projectId = p?.projectId ?? null;
  }
  const previous = projectId ? await jiraKeyFor(projectId) : defaultJiraKey();
  const rows = await db.query.proposals.findMany({
    where:
      "proposalId" in where
        ? and(eq(schema.proposals.id, where.proposalId), eq(schema.proposals.status, "pending"))
        : and(eq(schema.proposals.projectId, where.projectId), eq(schema.proposals.status, "pending")),
  });
  let moved = 0;
  for (const r of rows) {
    const out = moveToJiraProject(r.plan, key, previous);
    if (!out.moved && !r.plan.newJiraProject) continue;
    moved += out.moved;
    const what = out.moved ? `, so ${out.moved === 1 ? "the step" : `the ${out.moved} steps`} going to ${previous ?? "the old project"} moved there` : "";
    await saveCardVersion(r.id, r.plan, out.plan, { cause: "jira_project", reason: `You set ${key} as this project's Jira project${what}.` });
  }
  if (projectId) await setJiraKey(projectId, key);
  return { ok: true, key, moved };
}
