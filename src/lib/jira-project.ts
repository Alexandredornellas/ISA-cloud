// Which Jira project each ISA project creates tickets in. Reading and search cover every Jira
// project the account can see; new tickets, epics and sprints use the project's own key, or
// JIRA_PROJECT_KEY when it has none.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { jiraSearcher } from "@/lib/jira-research";
import type { JiraClient } from "@/lib/jira";

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

/** What drafting needs to choose a Jira project per ticket. */
export async function jiraProjectsText(projectId: string | null): Promise<string> {
  const [fallback, choices] = await Promise.all([jiraKeyFor(projectId), jiraProjectChoices()]);
  return [
    `Jira projects you can create tickets in: ${choices.length ? choices.map((c) => `${c.key} (${c.name})`).join(", ") : "(list unavailable)"}.`,
    `For each new ticket, set jiraProject to the Jira project it belongs in, judging from what you know: where the related tickets, its epic or this project's other tickets live, and what the item says. Use "" when unsure; it then goes to ${fallback ?? "the default project"}.`,
  ].join(" ");
}

/** Set (or clear, with "") the Jira project an ISA project uses. Returns the saved key or an error. */
export async function setJiraKey(projectId: string, raw: string): Promise<{ ok: true; key: string | null } | { ok: false; error: string }> {
  const key = raw.trim().toUpperCase();
  if (key && !JIRA_KEY.test(key)) return { ok: false, error: `"${raw}" is not a Jira project key (like SCRUM or CHK).` };
  await db.update(schema.projects).set({ jiraProjectKey: key || null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  return { ok: true, key: key || null };
}

let projectCache: { at: number; list: { key: string; name: string }[] } | null = null;

/** Jira projects to choose from (cached for five minutes); empty when Jira is not connected. */
export async function jiraProjectChoices(): Promise<{ key: string; name: string }[]> {
  if (projectCache && Date.now() - projectCache.at < 300_000) return projectCache.list;
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
