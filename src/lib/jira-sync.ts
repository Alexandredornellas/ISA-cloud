import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { JiraClient } from "@/lib/jira";

export type JiraReader = Pick<JiraClient, "projectIssues">;

/**
 * Bring ISA's requirements in line with Jira: tickets deleted in Jira are unlinked (so ISA can
 * propose them again), and each ticket's current status is recorded; done tickets mark the
 * requirement done. Optionally limited to one ISA project.
 */
export async function syncJira(jira: JiraReader, projectId?: string): Promise<{ checked: number; unlinked: number; done: number }> {
  const reqs = await db
    .select()
    .from(schema.requirements)
    .where(
      projectId
        ? and(isNotNull(schema.requirements.jiraIssueKey), eq(schema.requirements.projectId, projectId))
        : isNotNull(schema.requirements.jiraIssueKey),
    );
  if (!reqs.length) return { checked: 0, unlinked: 0, done: 0 };

  const jiraProjects = [...new Set(reqs.map((r) => r.jiraIssueKey!.split("-")[0]))];
  const byKey = new Map<string, Awaited<ReturnType<JiraReader["projectIssues"]>>[number]>();
  for (const key of jiraProjects) for (const issue of await jira.projectIssues(key)) byKey.set(issue.key, issue);

  let unlinked = 0;
  let done = 0;
  for (const r of reqs) {
    const issue = byKey.get(r.jiraIssueKey!);
    if (!issue) {
      await db
        .update(schema.requirements)
        .set({ jiraIssueKey: null, jiraStatus: null, updatedAt: new Date() })
        .where(eq(schema.requirements.id, r.id));
      unlinked += 1;
      continue;
    }
    const status = issue.done && r.status !== "dropped" ? "done" : r.status;
    if (status !== r.status) done += 1;
    if (issue.status !== r.jiraStatus || status !== r.status) {
      await db
        .update(schema.requirements)
        .set({ jiraStatus: issue.status, status, updatedAt: new Date() })
        .where(eq(schema.requirements.id, r.id));
    }
  }
  return { checked: reqs.length, unlinked, done };
}
