import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { proposeUpdate } from "@/lib/brain/pipeline";
import type { StructuredLLM } from "@/lib/brain/llm";
import { jiraBrowseUrl } from "@/lib/jira";
import type { TrackedChange } from "@/lib/jira-track";
import { log } from "@/lib/log";

// Changes that alter what a ticket asks for. Status, assignee and sprint moves are only logged.
const CONTENT_FIELDS = new Set(["summary", "description"]);

const FIELD = (f: string) => (f === "summary" ? "title" : f);

/**
 * When someone else changes what a ticket says, file it under the ticket's project as an item
 * and let ISA draft a suggestion: keep the change, restore what was agreed, or ask the person.
 * Returns the ids of the suggestions drafted.
 */
export async function reviewJiraChanges(changes: TrackedChange[], llm: StructuredLLM): Promise<string[]> {
  const byEntry = new Map<string, TrackedChange[]>();
  for (const c of changes) {
    if (!CONTENT_FIELDS.has(c.field) || !c.projectId || c.byIsa === "yes") continue;
    const k = `${c.key}:${c.historyId}`;
    byEntry.set(k, [...(byEntry.get(k) ?? []), c]);
  }

  const drafted: string[] = [];
  for (const [externalId, group] of byEntry) {
    const first = group[0];
    const content = [
      `${first.author ?? "Someone"} changed ${first.key} directly in Jira on ${first.changedAt.toISOString()}. ISA did not make this change and nobody approved it in ISA.`,
      ...group.map((c) => `\n${FIELD(c.field)} before:\n${c.fromValue ?? "(empty)"}\n\n${FIELD(c.field)} after:\n${c.toValue ?? "(empty)"}`),
      "\nCompare this with the requirement as it was agreed and say whether it changes what was agreed. Suggest one path: keep the change (update the requirement, and comment on the ticket who changed it and that the owner accepted it), restore the agreed text with jira_update, or ask the person who changed it, by Slack or email when you have a channel for them. Put the other paths in openQuestions.",
    ].join("\n");
    const [event] = await db
      .insert(schema.events)
      .values({
        source: "jira",
        externalId,
        title: `${first.key} ${group.map((c) => FIELD(c.field)).join(" and ")} changed by ${first.author ?? "someone"}`,
        author: first.author,
        occurredAt: first.changedAt,
        content,
        url: jiraBrowseUrl(first.key),
        status: "sorted",
      })
      .onConflictDoNothing()
      .returning();
    if (!event) continue;
    await db
      .insert(schema.eventProjects)
      .values({ eventId: event.id, projectId: first.projectId!, relation: "change", note: `${first.author ?? "Someone"} changed the ${group.map((c) => FIELD(c.field)).join(" and ")} of ${first.key} in Jira.` })
      .onConflictDoNothing();
    for (const c of group) await db.update(schema.ticketChanges).set({ eventId: event.id }).where(eq(schema.ticketChanges.id, c.id));
    try {
      const id = await proposeUpdate(first.projectId!, [event], llm);
      if (id) drafted.push(id);
    } catch (err) {
      log.error("jira review failed", err, { key: first.key });
    }
  }
  return drafted;
}
