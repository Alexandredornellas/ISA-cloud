// What the owner can ask ISA to do in the chat. These only read ISA's data or change proposals,
// projects and rules. Nothing here writes to Jira, Slack or email: that happens on approval.
import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { describeAction } from "@/lib/plan";
import { jiraBrowseUrl } from "@/lib/jira";
import { eventText, projectBlock } from "./context";
import type { StructuredLLM } from "./llm";
import { processEvent, redraftProject, refileEvent, reviseProposal } from "./pipeline";
import { syncJira, type JiraReader } from "@/lib/jira-sync";

export type ChatTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  run: (args: never) => Promise<string>;
};

function tool<S extends z.ZodType>(t: { name: string; description: string; inputSchema: S; run: (args: z.infer<S>) => Promise<string> }): ChatTool {
  return t as unknown as ChatTool;
}

const id = z.string().describe("An id exactly as ISA listed it");

export function chatTools(llm: StructuredLLM, jira: JiraReader | null = null): ChatTool[] {
  // Check Jira first, so ISA never reports tickets that were deleted or finished there.
  const fresh = async (projectId: string) => {
    if (jira) await syncJira(jira, projectId).catch(() => undefined);
  };
  return [
    tool({
      name: "list_projects",
      description: "List all projects with their ids and how many requirements each has.",
      inputSchema: z.object({}),
      run: async () => {
        const projects = await db.query.projects.findMany({ orderBy: desc(schema.projects.updatedAt) });
        const reqs = await db.select({ projectId: schema.requirements.projectId }).from(schema.requirements);
        if (!projects.length) return "There are no projects yet.";
        return projects
          .map((p) => `${p.id}: ${p.name} (${reqs.filter((r) => r.projectId === p.id).length} requirements)`)
          .join("\n");
      },
    }),
    tool({
      name: "get_project",
      description: "Read one project: summary, people, rules, and its requirements with their Jira tickets.",
      inputSchema: z.object({ projectId: id }),
      run: async ({ projectId }) => {
        await fresh(projectId);
        return projectBlock(projectId);
      },
    }),
    tool({
      name: "list_project_items",
      description:
        "List the meetings, emails, Slack messages and notes filed under a project, oldest first, with their ids, plus the Jira tickets ISA created for it with links.",
      inputSchema: z.object({ projectId: id }),
      run: async ({ projectId }) => {
        await fresh(projectId);
        const links = await db.select().from(schema.eventProjects).where(eq(schema.eventProjects.projectId, projectId));
        const evs = links.length
          ? await db.query.events.findMany({
              where: inArray(schema.events.id, links.map((l) => l.eventId)),
              orderBy: asc(schema.events.occurredAt),
            })
          : [];
        const tickets = await db
          .select({ key: schema.requirements.jiraIssueKey, title: schema.requirements.title, status: schema.requirements.jiraStatus })
          .from(schema.requirements)
          .where(eq(schema.requirements.projectId, projectId));
        return [
          "Items:",
          ...(evs.length
            ? evs.map((e) => `- ${e.id}: ${e.occurredAt.toISOString().slice(0, 16).replace("T", " ")} ${e.source} "${e.title}"${e.author ? ` from ${e.author}` : ""}`)
            : ["(none)"]),
          "Jira tickets:",
          ...(tickets.some((t) => t.key)
            ? tickets.filter((t) => t.key).map((t) => `- ${t.key} ${t.title} (${t.status}) ${jiraBrowseUrl(t.key!)}`)
            : ["(none created yet)"]),
        ].join("\n");
      },
    }),
    tool({
      name: "get_item",
      description: "Read one item in full, e.g. a whole meeting transcript or email, by its id.",
      inputSchema: z.object({ eventId: id }),
      run: async ({ eventId }) => {
        const e = await db.query.events.findFirst({ where: eq(schema.events.id, eventId) });
        return e ? eventText(e) : "Item not found.";
      },
    }),
    tool({
      name: "search_items",
      description:
        "Search the meetings, emails and Slack messages ISA has received, by words in the title or content. Newest first.",
      inputSchema: z.object({ query: z.string().describe("A word or short phrase") }),
      run: async ({ query }) => {
        const like = `%${query}%`;
        const rows = await db
          .select()
          .from(schema.events)
          .where(or(ilike(schema.events.title, like), ilike(schema.events.content, like)))
          .orderBy(desc(schema.events.occurredAt))
          .limit(8);
        if (!rows.length) return "Nothing found.";
        return rows.map((e) => `${eventText(e).slice(0, 2500)}\n(item status: ${e.status})`).join("\n\n");
      },
    }),
    tool({
      name: "list_pending_proposals",
      description: "List the proposals waiting in the owner's inbox, with what each would do.",
      inputSchema: z.object({}),
      run: async () => {
        const rows = await db.query.proposals.findMany({
          where: eq(schema.proposals.status, "pending"),
          orderBy: desc(schema.proposals.createdAt),
        });
        if (!rows.length) return "The inbox is empty.";
        return rows
          .map((p) =>
            [
              `${p.id} [${p.kind}] ${p.title}`,
              `  Summary: ${p.plan.summary}`,
              ...p.plan.requirementChanges.map((r) => `  Requirement ${r.ref} (${r.op}): ${r.title}`),
              ...p.plan.actions.map((a) => `  Will: ${describeAction(a)}`),
              `  From items: ${p.eventIds.join(", ") || "none"}`,
            ].join("\n"),
          )
          .join("\n\n");
      },
    }),
    tool({
      name: "draft_tickets_again",
      description:
        "Check the project's tickets in Jira, then draft a proposal from its latest items for every requirement that has no ticket (e.g. tickets deleted in Jira). The owner approves it in the inbox.",
      inputSchema: z.object({ projectId: id }),
      run: async ({ projectId }) => {
        const proposalId = await redraftProject(projectId, llm, jira);
        if (!proposalId) return "Checked Jira: every requirement still has its ticket, so there is nothing to draft.";
        const p = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
        return `Drafted ${proposalId} for the inbox: ${p?.plan.summary ?? ""}\n${(p?.plan.actions ?? []).map((a) => `Will: ${describeAction(a)}`).join("\n")}`;
      },
    }),
    tool({
      name: "revise_proposal",
      description:
        "Redraft a pending proposal following the owner's correction, e.g. 'make it one ticket', 'also tell Ana', 'MFA must support SMS'. The owner still approves it in the inbox.",
      inputSchema: z.object({ proposalId: id, instruction: z.string().describe("The correction, in the owner's words plus any detail you know") }),
      run: async ({ proposalId, instruction }) => {
        const plan = await reviseProposal(proposalId, instruction, llm);
        return `Revised. ${plan.summary}\n${plan.actions.map((a) => `Will: ${describeAction(a)}`).join("\n")}`;
      },
    }),
    tool({
      name: "dismiss_proposal",
      description: "Dismiss a pending proposal the owner does not want.",
      inputSchema: z.object({ proposalId: id }),
      run: async ({ proposalId }) => {
        const rows = await db
          .update(schema.proposals)
          .set({ status: "dismissed", decidedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.status, "pending")))
          .returning({ id: schema.proposals.id });
        return rows.length ? "Dismissed." : "That proposal is not pending.";
      },
    }),
    tool({
      name: "move_item",
      description:
        "File an item (meeting, email or Slack message) under a different project, or under a new project, and draft a fresh proposal there. Pending proposals drafted from the item are dismissed.",
      inputSchema: z.object({
        eventId: id,
        projectId: z.string().nullable().describe("Target project id, or null for a new project"),
        newProjectName: z.string().nullable().describe("Name for a new project when projectId is null"),
      }),
      run: async ({ eventId, projectId, newProjectName }) => {
        const target = projectId ? { projectId } : { newProjectName: newProjectName || "New project" };
        const proposalId = await refileEvent(eventId, target, llm);
        return proposalId ? `Moved. New proposal ${proposalId} is in the inbox.` : "Moved. It changes nothing in that project.";
      },
    }),
    tool({
      name: "add_project_rule",
      description:
        "Save a standing rule for a project that ISA follows when sorting and drafting, e.g. 'Ana approves all design changes' or 'post updates in #login'.",
      inputSchema: z.object({ projectId: id, rule: z.string() }),
      run: async ({ projectId, rule }) => {
        await db.insert(schema.projectRules).values({ projectId, text: rule });
        return "Rule saved.";
      },
    }),
    tool({
      name: "rename_project",
      description: "Rename a project in ISA.",
      inputSchema: z.object({ projectId: id, name: z.string() }),
      run: async ({ projectId, name }) => {
        await db.update(schema.projects).set({ name, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
        return "Renamed.";
      },
    }),
    tool({
      name: "add_note",
      description:
        "Give ISA new information as if it came in from a meeting or message, e.g. a decision the owner made by phone. ISA sorts it into projects and drafts proposals for the inbox.",
      inputSchema: z.object({ title: z.string(), text: z.string() }),
      run: async ({ title, text }) => {
        const [e] = await db
          .insert(schema.events)
          .values({ source: "manual", externalId: crypto.randomUUID(), title, author: "Owner", occurredAt: new Date(), content: text })
          .returning();
        const out = await processEvent(e.id, llm);
        if (out.kind === "ignored") return "ISA found nothing to change from this note.";
        const proposals = await db.query.proposals.findMany({ where: inArray(schema.proposals.id, out.proposalIds) });
        return `Drafted for the inbox:\n${proposals.map((p) => `${p.id}: ${p.title}`).join("\n")}`;
      },
    }),
  ];
}
