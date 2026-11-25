import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { epicName, mergePeople } from "@/lib/executor";
import { log } from "@/lib/log";

export type MergeResult = { requirements: number; items: number };

/**
 * Fold one project into another as an epic: everything ISA knows about the source (requirements
 * and their trail, filed items, suggestions, reminders, people, rules, tickets, diagrams, chat)
 * moves to the target, its requirements go under the epic, and the source project is removed.
 * Nothing changes outside ISA: Jira tickets stay where they are.
 */
export async function mergeProjectInto(sourceId: string, targetId: string, epic: string): Promise<MergeResult> {
  if (sourceId === targetId) throw new Error("Pick a different project to merge into");
  return db.transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.query.projects.findFirst({ where: eq(schema.projects.id, sourceId) }),
      tx.query.projects.findFirst({ where: eq(schema.projects.id, targetId) }),
    ]);
    if (!source || !target) throw new Error("Project not found");
    const name = epicName(epic) ?? epicName(source.name) ?? "General";
    // Reuse the target's spelling when it already has this epic ("login" and "Login" are one epic).
    const existing = await tx
      .selectDistinct({ epic: schema.requirements.epic })
      .from(schema.requirements)
      .where(eq(schema.requirements.projectId, targetId));
    const spelled = existing.find((e) => e.epic?.toLowerCase() === name.toLowerCase())?.epic ?? name;

    const moved = await tx
      .update(schema.requirements)
      .set({ projectId: targetId, epic: spelled, updatedAt: new Date() })
      .where(eq(schema.requirements.projectId, sourceId))
      .returning({ id: schema.requirements.id });

    // An item filed under both projects keeps its link to the target only.
    const links = await tx.select().from(schema.eventProjects).where(eq(schema.eventProjects.projectId, sourceId));
    const already = links.length
      ? new Set(
          (
            await tx
              .select({ eventId: schema.eventProjects.eventId })
              .from(schema.eventProjects)
              .where(and(eq(schema.eventProjects.projectId, targetId), inArray(schema.eventProjects.eventId, links.map((l) => l.eventId))))
          ).map((l) => l.eventId),
        )
      : new Set<string>();
    if (already.size) {
      await tx
        .delete(schema.eventProjects)
        .where(and(eq(schema.eventProjects.projectId, sourceId), inArray(schema.eventProjects.eventId, [...already])));
    }
    await tx.update(schema.eventProjects).set({ projectId: targetId }).where(eq(schema.eventProjects.projectId, sourceId));

    const move = { projectId: targetId };
    await tx.update(schema.requirementVersions).set(move).where(eq(schema.requirementVersions.projectId, sourceId));
    await tx.update(schema.proposals).set(move).where(eq(schema.proposals.projectId, sourceId));
    await tx.update(schema.actions).set(move).where(eq(schema.actions.projectId, sourceId));
    await tx.update(schema.projectRules).set(move).where(eq(schema.projectRules.projectId, sourceId));
    await tx.update(schema.chatMessages).set(move).where(eq(schema.chatMessages.projectId, sourceId));
    await tx.update(schema.jiraTickets).set(move).where(eq(schema.jiraTickets.projectId, sourceId));
    await tx.update(schema.ticketChanges).set(move).where(eq(schema.ticketChanges.projectId, sourceId));
    await tx.update(schema.reminders).set(move).where(eq(schema.reminders.projectId, sourceId));
    await tx.update(schema.personDuties).set(move).where(eq(schema.personDuties.projectId, sourceId));
    await tx.update(schema.personSuggestions).set(move).where(eq(schema.personSuggestions.projectId, sourceId));
    await tx.update(schema.diagrams).set(move).where(eq(schema.diagrams.projectId, sourceId));

    await tx
      .update(schema.projects)
      .set({
        people: mergePeople(target.people, source.people),
        jiraProjectKey: target.jiraProjectKey ?? source.jiraProjectKey,
        slackChannelId: target.slackChannelId ?? source.slackChannelId,
        updatedAt: new Date(),
      })
      .where(eq(schema.projects.id, targetId));
    await tx.delete(schema.projects).where(eq(schema.projects.id, sourceId));

    log.info("project merged", { sourceId, targetId, requirements: moved.length, items: links.length });
    return { requirements: moved.length, items: links.length };
  });
}

/** Put one requirement under an epic by hand ("" takes it out of its epic). ISA's record only. */
export async function setRequirementEpic(requirementId: string, epic: string): Promise<void> {
  await db
    .update(schema.requirements)
    .set({ epic: epicName(epic), updatedAt: new Date() })
    .where(eq(schema.requirements.id, requirementId));
}
