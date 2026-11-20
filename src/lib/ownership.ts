// Which ISA project owns each Jira ticket and requirement, so a draft for one project cannot
// change another project's tickets (e.g. a meeting that covered two topics).
import { db, schema } from "@/db";
import type { Plan } from "@/lib/plan";

export type Owner = { projectId: string; name: string };
export type Owners = { tickets: Map<string, Owner>; requirements: Map<string, Owner> };

export async function owners(): Promise<Owners> {
  const [projects, reqs, tickets] = await Promise.all([
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects),
    db.select({ id: schema.requirements.id, projectId: schema.requirements.projectId, key: schema.requirements.jiraIssueKey }).from(schema.requirements),
    db.select({ key: schema.jiraTickets.key, projectId: schema.jiraTickets.projectId }).from(schema.jiraTickets),
  ]);
  const name = new Map(projects.map((p) => [p.id, p.name]));
  const owner = (projectId: string | null): Owner | null => (projectId && name.has(projectId) ? { projectId, name: name.get(projectId)! } : null);
  const ticketMap = new Map<string, Owner>();
  for (const t of tickets) {
    const o = owner(t.projectId);
    if (o) ticketMap.set(t.key, o);
  }
  // A requirement's own ticket is the stronger link.
  for (const r of reqs) {
    const o = owner(r.projectId);
    if (o && r.key) ticketMap.set(r.key, o);
  }
  const reqMap = new Map<string, Owner>();
  for (const r of reqs) {
    const o = owner(r.projectId);
    if (o) reqMap.set(r.id, o);
  }
  return { tickets: ticketMap, requirements: reqMap };
}

/**
 * Keep a project's draft to that project: drop steps that touch tickets or requirements another
 * ISA project owns, and unlink epics that belong elsewhere. Each drop is noted for the owner.
 */
export function keepToProject(plan: Plan, projectId: string, own: Owners): { plan: Plan; dropped: string[] } {
  const dropped: string[] = [];
  const other = (o: Owner | undefined) => (o && o.projectId !== projectId ? o : null);

  const requirementChanges = plan.requirementChanges.filter((r) => {
    const o = other(own.requirements.get(r.ref));
    if (o) dropped.push(`a change to a requirement of "${o.name}"`);
    return !o;
  });

  const actions = plan.actions.flatMap((a): Plan["actions"] => {
    if (a.type === "jira_create") {
      const o = a.epicRef ? other(own.tickets.get(a.epicRef)) : null;
      if (o) {
        dropped.push(`placing "${a.summary}" under ${a.epicRef}, an epic of "${o.name}"`);
        return [{ ...a, epicRef: null }];
      }
      return [a];
    }
    if (a.type === "jira_update" || a.type === "jira_comment" || a.type === "jira_close") {
      const o = other(a.issueKey ? own.tickets.get(a.issueKey) : undefined) ?? other(own.requirements.get(a.requirementRef));
      if (o) {
        const verb = a.type === "jira_update" ? "update" : a.type === "jira_comment" ? "comment" : "close";
        dropped.push(`the ${verb} on ${a.issueKey ?? "a ticket"}, which belongs to "${o.name}"`);
        return [];
      }
    }
    return [a];
  });

  if (!dropped.length) return { plan, dropped };
  const note = `ISA left out ${dropped.join("; ")}. Those parts belong to another project and are drafted there.`;
  return { plan: { ...plan, requirementChanges, actions, openQuestions: [...plan.openQuestions, note] }, dropped };
}
