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

/** The Jira project key an ISA project creates tickets in. */
export async function jiraKeyFor(projectId: string | null | undefined): Promise<string | null> {
  if (projectId) {
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { jiraProjectKey: true } });
    if (p?.jiraProjectKey) return p.jiraProjectKey;
  }
  return defaultJiraKey();
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
