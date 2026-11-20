import { asc, eq, ne, and } from "drizzle-orm";
import { db, schema } from "@/db";
import { jiraBrowseUrl } from "@/lib/jira";

type EventRow = typeof schema.events.$inferSelect;

/** All projects with their requirements, people and rules, as text for Claude. */
export async function projectsContext(): Promise<{ text: string; projectIds: Set<string> }> {
  const projects = await db.query.projects.findMany({ orderBy: asc(schema.projects.createdAt) });
  if (projects.length === 0) {
    return { text: "<projects>\nThere are no projects yet.\n</projects>", projectIds: new Set() };
  }
  const blocks: string[] = [];
  for (const p of projects) blocks.push(await projectBlock(p.id));
  return { text: `<projects>\n${blocks.join("\n\n")}\n</projects>`, projectIds: new Set(projects.map((p) => p.id)) };
}

/** One project as text: summary, people, rules, and each live requirement with its ticket. */
export async function projectBlock(projectId: string): Promise<string> {
  const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!p) throw new Error("Project not found");
  const [reqs, rules, tickets] = await Promise.all([
    db.query.requirements.findMany({
      where: and(eq(schema.requirements.projectId, projectId), ne(schema.requirements.status, "dropped")),
      orderBy: asc(schema.requirements.createdAt),
    }),
    db.query.projectRules.findMany({
      where: eq(schema.projectRules.projectId, projectId),
      orderBy: asc(schema.projectRules.createdAt),
    }),
    db.select({ key: schema.jiraTickets.key, issueType: schema.jiraTickets.issueType, epic: schema.jiraTickets.epic }).from(schema.jiraTickets).where(eq(schema.jiraTickets.projectId, projectId)),
  ]);
  const ticketOf = new Map(tickets.map((t) => [t.key, t]));
  const lines = [
    `<project id="${p.id}">`,
    `Name: ${p.name}`,
    `Summary: ${p.summary || "(none)"}`,
    `People: ${p.people.length ? p.people.map(personText).join("; ") : "(none recorded)"}`,
    p.slackChannelId ? `Slack channel: ${p.slackChannelId}` : null,
    rules.length ? `Rules from the user:\n${rules.map((r) => `- ${r.text}`).join("\n")}` : null,
    "Requirements:",
    ...(reqs.length
      ? reqs.map(
          (r) =>
            `- [${r.id}] ${r.title} (status: ${r.status}${r.approvedBy ? `, approved by ${r.approvedBy}` : ""}${
              r.jiraIssueKey
                ? `, Jira ${r.jiraIssueKey}${ticketOf.get(r.jiraIssueKey)?.issueType ? ` [${ticketOf.get(r.jiraIssueKey)!.issueType}]` : ""}${r.jiraStatus ? ` (${r.jiraStatus})` : ""}${ticketOf.get(r.jiraIssueKey)?.epic ? ` under epic ${ticketOf.get(r.jiraIssueKey)!.epic}` : ""} ${jiraBrowseUrl(r.jiraIssueKey)}`
                : ", no ticket yet"
            })${r.description ? `\n  ${r.description.replace(/\n/g, "\n  ")}` : ""}`,
        )
      : ["(none yet)"]),
    "</project>",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

function personText(p: { name: string; email: string | null; slackUserId: string | null; role: string | null }) {
  const bits = [p.role, p.email, p.slackUserId ? `Slack ${p.slackUserId}` : null].filter(Boolean);
  return bits.length ? `${p.name} (${bits.join(", ")})` : p.name;
}

const SOURCE_NAME: Record<string, string> = {
  zoom: "Zoom meeting transcript",
  meet: "Google Meet transcript",
  teams: "Teams meeting transcript",
  gmail: "Email",
  slack: "Slack message",
  manual: "Note",
};

/** One incoming item as text, including where a reply on the same channel would go. */
export function eventText(e: EventRow): string {
  const reply = e.replyTo
    ? `Reply on the same channel: ${Object.entries(e.replyTo)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`
    : null;
  return [
    `<item id="${e.id}" source="${SOURCE_NAME[e.source] ?? e.source}">`,
    `Title: ${e.title}`,
    `When: ${e.occurredAt.toISOString()}`,
    e.author ? `From: ${e.author}` : null,
    e.url ? `Link: ${e.url}` : null,
    e.participants.length ? `Participants: ${e.participants.map(personText).join("; ")}` : null,
    reply,
    "Content:",
    e.content,
    "</item>",
  ]
    .filter((l) => l !== null)
    .join("\n");
}
