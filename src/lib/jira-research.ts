import { JiraClient, jiraConfigFromEnv, type FoundTicket } from "@/lib/jira";
import { owners } from "@/lib/ownership";
import { log } from "@/lib/log";

export type JiraSearcher = Pick<JiraClient, "searchText">;

let searcher: JiraSearcher | null | undefined;

/** The Jira search ISA uses while drafting; null when Jira is not configured. */
export function jiraSearcher(): JiraSearcher | null {
  if (searcher === undefined) {
    try {
      searcher = new JiraClient(jiraConfigFromEnv());
    } catch {
      searcher = null;
    }
  }
  return searcher;
}

/** Replace the Jira search (tests, or null to turn research off). */
export function useJiraSearcher(s: JiraSearcher | null | undefined) {
  searcher = s;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

/** A note to add after a ticket's line, e.g. which ISA project it belongs to. */
export type TicketNote = (key: string) => string | null;

export function ticketsText(tickets: FoundTicket[], note: TicketNote = () => null): string {
  return tickets
    .map((t) =>
      [
        `- ${t.key} [${t.issueType ?? "ticket"}] ${t.summary} (${t.url})`,
        note(t.key) ? `  ${note(t.key)}` : null,
        `  Status: ${t.status ?? "?"} | Assignee: ${t.assignee ?? "nobody"} | Sprint: ${t.sprint ?? "none"} | Epic: ${t.epic ?? "none"}${t.labels.length ? ` | Labels: ${t.labels.join(", ")}` : ""}`,
        t.description ? `  Description: ${clip(t.description.replace(/\s+/g, " "), 700)}` : null,
        ...t.comments.map((c) => `  Comment by ${c.author ?? "someone"}${c.at ? ` on ${c.at.toISOString().slice(0, 10)}` : ""}: ${clip(c.text.replace(/\s+/g, " "), 300)}`),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

/** Search Jira for these terms and describe what it holds, for Claude to read. */
export async function researchJira(jira: JiraSearcher, terms: string[], limit = 10, note?: TicketNote): Promise<string> {
  const found = await jira.searchText(terms, limit);
  if (!found.length) return `Searched Jira for ${terms.map((t) => `"${t}"`).join(", ")}: no tickets mention them.`;
  return `Jira tickets that mention ${terms.map((t) => `"${t}"`).join(", ")}, most recently updated first:\n${ticketsText(found, note)}`;
}

/**
 * The block added to a draft's context: tickets already in Jira about the item's topics, so ISA
 * updates or links existing work instead of creating duplicates. Empty when there is nothing to add.
 */
export async function relatedTicketsBlock(terms: string[], projectId: string | null = null): Promise<string> {
  const jira = jiraSearcher();
  if (!jira || !terms.length) return "";
  try {
    const own = await owners();
    const note: TicketNote = (key) => {
      const o = own.tickets.get(key);
      if (!o) return null;
      return projectId && o.projectId !== projectId
        ? `Belongs to another ISA project, "${o.name}": do not update, comment on or close it from this project.`
        : `ISA project: "${o.name}".`;
    };
    return `Related tickets already in Jira (ISA searched for the item's topics):\n${await researchJira(jira, terms, 8, note)}`;
  } catch (err) {
    log.error("jira research failed", err);
    return "";
  }
}

const sprintCache = new Map<string, { at: number; names: string[] }>();

/** Names of a Jira project's active and future sprints (cached for a minute); empty when unknown. */
export async function openSprintNames(jiraKey?: string | null): Promise<string[]> {
  const key = jiraKey || process.env.JIRA_PROJECT_KEY || "";
  const hit = sprintCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.names;
  const jira = jiraSearcher();
  if (!key || !jira || !("openSprints" in jira)) return [];
  try {
    const names = (await (jira as JiraClient).openSprints(key)).map((s) => s.name);
    sprintCache.set(key, { at: Date.now(), names });
    return names;
  } catch (err) {
    log.error("jira sprints failed", err);
    return [];
  }
}
