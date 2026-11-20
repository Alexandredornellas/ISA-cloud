import { JiraClient, jiraConfigFromEnv, type FoundTicket } from "@/lib/jira";

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

export function ticketsText(tickets: FoundTicket[]): string {
  return tickets
    .map((t) =>
      [
        `- ${t.key} [${t.issueType ?? "ticket"}] ${t.summary} (${t.url})`,
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
export async function researchJira(jira: JiraSearcher, terms: string[], limit = 10): Promise<string> {
  const found = await jira.searchText(terms, limit);
  if (!found.length) return `Searched Jira for ${terms.map((t) => `"${t}"`).join(", ")}: no tickets mention them.`;
  return `Jira tickets that mention ${terms.map((t) => `"${t}"`).join(", ")}, most recently updated first:\n${ticketsText(found)}`;
}

/**
 * The block added to a draft's context: tickets already in Jira about the item's topics, so ISA
 * updates or links existing work instead of creating duplicates. Empty when there is nothing to add.
 */
export async function relatedTicketsBlock(terms: string[]): Promise<string> {
  const jira = jiraSearcher();
  if (!jira || !terms.length) return "";
  try {
    return `Related tickets already in Jira (ISA searched for the item's topics):\n${await researchJira(jira, terms, 8)}`;
  } catch (err) {
    console.error("jira research failed", { error: err instanceof Error ? err.name : "unknown" });
    return "";
  }
}
