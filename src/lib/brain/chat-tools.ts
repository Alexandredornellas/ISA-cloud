// What the owner can ask ISA to do in the chat. These only read ISA's data or change proposals,
// projects and rules. Nothing here writes to Jira, Slack or email: that happens on approval.
import { and, asc, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { log } from "@/lib/log";
import { describeAction } from "@/lib/plan";
import { jiraBrowseUrl } from "@/lib/jira";
import { eventText, projectBlock } from "./context";
import type { StructuredLLM } from "./llm";
import { alsoFileEvent, processEvent, redraftProject, refileEvent, reviseProposal } from "./pipeline";
import { syncJira, type JiraReader } from "@/lib/jira-sync";
import { describeChange, ticketHistory } from "@/lib/jira-track";
import { researchJira, type JiraSearcher } from "@/lib/jira-research";
import { portfolio, portfolioText } from "@/lib/portfolio";
import { addReminder, dayKey, openReminders, remindersText, setReminderStatus } from "@/lib/reminders";
import { addDuty, directory, personLine, updatePerson, upsertPerson, type DirectoryEntry } from "@/lib/people";
import { claudeStructured } from "@/lib/brain/llm";
import { decisionList, decisionTrail, trailText, versionLine, type DecisionRow } from "@/lib/trail";
import { versionAt } from "@/lib/versions";
import { adoptJiraProject, defaultJiraKey, jiraProjectChoices, setJiraKey } from "@/lib/jira-project";
import { confluenceConfigured, importPage, searchPages } from "@/lib/confluence";
import { drawDiagram } from "@/lib/brain/diagram";

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

export function chatTools(llm: StructuredLLM, jira: JiraReader | null = null, searcher: JiraSearcher | null = null): ChatTool[] {
  // Check Jira first, so ISA never reports tickets that were deleted or finished there.
  // Returns a line saying what ISA checked, so it can tell the owner where its answer comes from.
  const fresh = async (projectId: string): Promise<string> => {
    if (!jira) return "Jira is not connected, so the tickets below are ISA's last record, not checked in Jira.";
    try {
      const r = await syncJira(jira, projectId);
      const gone = r.unlinked ? ` ${r.unlinked} ticket(s) were deleted in Jira and are now unlinked.` : "";
      return `Checked Jira just now: ${r.checked - r.unlinked} of ${r.checked} linked ticket(s) still exist in Jira.${gone}`;
    } catch (err) {
      log.warn("chat jira check failed", { projectId }, err);
      return `Could not check Jira just now (${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}), so the tickets below may be out of date.`;
    }
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
        const checked = await fresh(projectId);
        return `${checked}\n\n${await projectBlock(projectId)}`;
      },
    }),
    tool({
      name: "list_project_items",
      description:
        "List the meetings, emails, Slack messages and notes filed under a project, oldest first, with their ids, plus the Jira tickets ISA created for it with links.",
      inputSchema: z.object({ projectId: id }),
      run: async ({ projectId }) => {
        const checked = await fresh(projectId);
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
          checked,
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
        "Search the meetings, emails and Slack messages ISA has received, by words in the title or content. Newest first. Items the owner marked as not relevant are left out unless includeIgnored is true (only when the owner asks for them).",
      inputSchema: z.object({ query: z.string().describe("A word or short phrase"), includeIgnored: z.boolean().nullable() }),
      run: async ({ query, includeIgnored }) => {
        const like = `%${query}%`;
        const rows = await db
          .select()
          .from(schema.events)
          .where(
            and(
              or(ilike(schema.events.title, like), ilike(schema.events.content, like)),
              includeIgnored ? undefined : ne(schema.events.status, "ignored"),
            ),
          )
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
              ...p.plan.actions.map((a) => `  Will: ${describeAction(a, p.plan)}`),
              ...(p.plan.newJiraProject
                ? [`  Suggests creating Jira project ${p.plan.newJiraProject.key} "${p.plan.newJiraProject.name}" (${p.plan.newJiraProject.template}); its tickets wait until the owner creates it and gives the key (set_jira_project).`]
                : []),
              `  From items: ${p.eventIds.join(", ") || "none"}`,
            ].join("\n"),
          )
          .join("\n\n");
      },
    }),
    tool({
      name: "research_jira",
      description:
        "Search all of Jira for tickets about a topic: titles, descriptions and comments, in every project, including tickets ISA did not create. Returns each ticket's key, link, status, assignee, sprint, epic, description and latest comments. Use it before answering anything about a topic.",
      inputSchema: z.object({
        terms: z.array(z.string()).describe("2 or 3 short search terms for the topic, including synonyms, e.g. [\"MFA\", \"two-factor\", \"OTP\"]"),
      }),
      run: async ({ terms }) => {
        if (!searcher) return "Jira is not connected, so ISA cannot search it.";
        return researchJira(searcher, terms, 15);
      },
    }),
    tool({
      name: "ticket_history",
      description:
        "What changed in Jira on a project's tickets, or on one ticket: who changed which field, from what, to what, and when. Also each ticket's last known assignee, sprint, epic and status.",
      inputSchema: z.object({
        projectId: z.string().nullable().describe("A project id, or null when asking about one ticket"),
        ticketKey: z.string().nullable().describe("A Jira key like SCRUM-12, or null for the whole project"),
      }),
      run: async ({ projectId, ticketKey }) => {
        if (!projectId && !ticketKey) return "Give a project id or a ticket key.";
        const snaps = await db
          .select()
          .from(schema.jiraTickets)
          .where(ticketKey ? eq(schema.jiraTickets.key, ticketKey) : eq(schema.jiraTickets.projectId, projectId!));
        const changes = await ticketHistory(ticketKey ? { key: ticketKey } : { projectId: projectId! });
        return [
          "Tickets (last known state):",
          ...(snaps.length
            ? snaps.map(
                (t) =>
                  `- ${t.key} ${t.summary} | ${t.deletedAt ? "deleted in Jira" : (t.status ?? "?")} | assignee: ${t.assignee ?? "nobody"} | sprint: ${t.sprint ?? "none"} | epic: ${t.epic ?? "none"} | ${jiraBrowseUrl(t.key)}`,
              )
            : ["(ISA has not checked these tickets yet)"]),
          "Changes, newest first:",
          ...(changes.length
            ? changes.map((c) => `- ${c.changedAt.toISOString().slice(0, 16).replace("T", " ")} ${describeChange(c)}${c.field === "description" && c.toValue ? `. New text: ${c.toValue.slice(0, 600)}` : ""}`)
            : ["(no changes recorded)"]),
        ].join("\n");
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
        return `Drafted ${proposalId} for the inbox: ${p?.plan.summary ?? ""}\n${(p?.plan.actions ?? []).map((a) => `Will: ${describeAction(a, p?.plan)}`).join("\n")}`;
      },
    }),
    tool({
      name: "revise_proposal",
      description:
        "Redraft a pending proposal following the owner's correction, e.g. 'make it one ticket', 'also tell Ana', 'MFA must support SMS'. The owner still approves it in the inbox.",
      inputSchema: z.object({ proposalId: id, instruction: z.string().describe("The correction, in the owner's words plus any detail you know") }),
      run: async ({ proposalId, instruction }) => {
        const plan = await reviseProposal(proposalId, instruction, llm);
        return `Revised. ${plan.summary}\n${plan.actions.map((a) => `Will: ${describeAction(a, plan)}`).join("\n")}`;
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
      name: "also_file_item",
      description:
        "File an item under one more project while keeping it where it is, when it covered several topics (e.g. a meeting about two projects). Drafts a proposal for that project from only the part about it.",
      inputSchema: z.object({
        eventId: id,
        projectId: id,
        about: z.string().describe("Which part of the item concerns this project, in one sentence"),
      }),
      run: async ({ eventId, projectId, about }) => {
        const proposalId = await alsoFileEvent(eventId, projectId, about, llm);
        return proposalId ? `Filed there too. Proposal ${proposalId} is waiting in that project's channel.` : "Filed there too. It changes nothing in that project.";
      },
    }),
    tool({
      name: "portfolio_status",
      description:
        "Health of all the owner's projects at once: which are at risk or need attention and why (Jira drifting from what was agreed, overdue promises, failed or long-waiting suggestions), plus who owes what. Use for 'how are my projects?', 'what's at risk?', and before writing a status report.",
      inputSchema: z.object({}),
      run: async () => {
        const { projects, reminders } = await portfolio();
        return portfolioText(projects, reminders);
      },
    }),
    tool({
      name: "list_reminders",
      description:
        "Open reminders: what the owner promised to send or do (for whom, by when) and what others owe the owner (WAITING ON), picked up from meetings, email and Slack. Use for 'what do I owe?', 'who owes me what?', 'what's due this week?'.",
      inputSchema: z.object({ projectId: z.string().nullable().describe("Only this project's reminders, or null for all") }),
      run: async ({ projectId }) => `Today is ${dayKey(new Date())}.\n${remindersText(await openReminders(projectId))}`,
    }),
    tool({
      name: "add_reminder",
      description:
        "Add a reminder when the owner asks ('remind me to send Ana the specs by Friday'), or a waiting-on ('Bruno owes me the API docs by Monday'). Internal to ISA: it contacts no one.",
      inputSchema: z.object({
        text: z.string().describe("What to send or do, starting with a verb"),
        direction: z.enum(["mine", "theirs"]).describe("mine: the owner owes it; theirs: person owes it to the owner"),
        person: z.string().nullable().describe("Who it is for (mine) or who owes it (theirs)"),
        due: z.string().nullable().describe("Deadline as YYYY-MM-DD, resolved from today's date; null when none"),
        projectId: z.string().nullable(),
      }),
      run: async (input) => {
        const r = await addReminder(input);
        return `Added reminder ${r.id}: ${r.text}${r.due ? `, due ${dayKey(r.due)}` : ""}.`;
      },
    }),
    tool({
      name: "complete_reminder",
      description: "Mark a reminder done when the owner says they did it, or dismiss it when it is not needed.",
      inputSchema: z.object({ reminderId: id, status: z.enum(["done", "dismissed"]) }),
      run: async ({ reminderId, status }) => {
        await setReminderStatus(reminderId, status);
        return status === "done" ? "Marked done." : "Dismissed.";
      },
    }),
    tool({
      name: "find_decisions",
      description:
        "Search ISA's decision memory: requirements across projects by words in their title, description, Jira key or project name. Use it first for 'why did we decide X?', then call decision_trail on the best match.",
      inputSchema: z.object({ query: z.string().describe("Words from the decision, e.g. 'Pix', 'card storage', 'CHK-14'"), projectId: z.string().nullable() }),
      run: async ({ query, projectId }) => {
        let rows = await decisionList({ query, projectId, limit: 15 });
        if (!rows.length) {
          const seen = new Map<string, DecisionRow>();
          for (const w of query.split(/\s+/).filter((w) => w.length > 2)) for (const r of await decisionList({ query: w, projectId, limit: 10 })) seen.set(r.id, r);
          rows = [...seen.values()];
        }
        return rows.length
          ? rows.map((r) => `- [${r.id}] ${r.title} (${r.projectName}; ${r.status}${r.jiraIssueKey ? `; ${r.jiraIssueKey}` : ""})`).join("\n")
          : "No requirement matches. Try search_items for conversations, or search_confluence for documents.";
      },
    }),
    tool({
      name: "decision_trail",
      description:
        "The full history of one requirement, including every version it has had (what it said, from when to when, and why it changed): which meetings, Slack threads, emails and Confluence pages raised or changed it, who approved what and why, what is waiting for the owner, and what happened to its Jira ticket. Answer 'why' questions from this, citing each source by type, title, person and date, and link the owner to the trail page.",
      inputSchema: z.object({
        requirementId: id,
        asOf: z.string().nullable().describe("A date (YYYY-MM-DD) to answer 'what did we agree on that day?', or null"),
      }),
      run: async ({ requirementId, asOf }) => {
        const t = await decisionTrail(requirementId);
        if (!t) return "Requirement not found.";
        let at = "";
        if (asOf) {
          const day = new Date(`${asOf}T23:59:59Z`);
          const v = Number.isNaN(day.getTime()) ? null : await versionAt(requirementId, day);
          at = v ? `\nIn force at the end of ${asOf}:\n${versionLine(v)}` : `\nOn ${asOf} this requirement did not exist yet.`;
        }
        return `${trailText(t)}${at}\nTrail page for the owner: /decisions/${t.requirement.id}`;
      },
    }),
    tool({
      name: "search_confluence",
      description: "Search Confluence pages (read-only) by words. Use it for specs, PRDs, meeting notes and decisions written down outside ISA.",
      inputSchema: z.object({ query: z.string() }),
      run: async ({ query }) => {
        if (!confluenceConfigured()) return "Confluence is not connected (it uses the Jira sign-in).";
        const hits = await searchPages(query);
        return hits.length ? hits.map((h) => `- [${h.id}] ${h.title}${h.space ? ` (${h.space})` : ""}: ${h.excerpt} ${h.url}`).join("\n") : "No Confluence page matches.";
      },
    }),
    tool({
      name: "add_confluence_page",
      description: "Add a Confluence page to ISA's memory when the owner asks, so it is sorted into projects and its decisions are kept. Read-only on Confluence.",
      inputSchema: z.object({ page: z.string().describe("The page link or id") }),
      run: async ({ page }) => {
        const r = await importPage(page);
        return r.added ? `Added "${r.title}" to memory. ISA will file it under its projects in a few seconds.` : `"${r.title}" (this version) is already in memory.`;
      },
    }),
    tool({
      name: "draw_diagram",
      description:
        "Draw a diagram (user flow, sequence between systems, or states) from a project's records, or one requirement's, and save it for the owner. Returns the link to show.",
      inputSchema: z.object({
        projectId: id,
        requirementId: z.string().nullable(),
        kind: z.enum(["flow", "sequence", "state"]),
        ask: z.string().nullable().describe("What the owner wants the diagram to show, in their words"),
      }),
      run: async (input) => {
        const d = await drawDiagram(claudeStructured, input);
        return `Drew "${d.title}". Show the owner: /diagrams#${d.id}${d.notes ? `\nOpen points: ${d.notes}` : ""}`;
      },
    }),
    tool({
      name: "find_people",
      description:
        "Search the owner's people directory. Each person has duties: what they do or can help with, each on a project or company-wide, and one person can hold many across projects. Use it to answer 'who knows PCI?', 'who can approve the budget?', 'who are the stakeholders on X?', and to suggest who could unblock something. Matches names, titles, teams, notes, duties and project names. Empty query lists everyone.",
      inputSchema: z.object({ query: z.string().describe("A name, team, topic or project name; '' for everyone") }),
      run: async ({ query }) => {
        let rows = await directory(query);
        if (!rows.length && query.includes(" ")) {
          const words = query.split(/\s+/).filter((w) => w.length > 3);
          const seen = new Map<string, DirectoryEntry>();
          for (const w of words) for (const r of await directory(w)) seen.set(r.id, r);
          rows = [...seen.values()];
        }
        if (!rows.length) return "Nobody in the directory matches. Suggest the owner adds who they know, or search the items.";
        return rows.slice(0, 40).map((r) => `- [${r.id}] ${personLine(r)}`).join("\n");
      },
    }),
    tool({
      name: "set_jira_project",
      description:
        "Choose which Jira project an ISA project creates new tickets, epics and sprints in, when the owner asks (e.g. 'Checkout tickets go to CHK'), or when the owner says they created the Jira project a suggestion proposed (e.g. 'NFS8 is created'): waiting suggestions' tickets that were going to the old project, or waiting for the new one, then move there. Use this, not revise_proposal, to move tickets to another Jira project: it needs no redraft. Pass an empty key to go back to the default. This changes ISA's setting and drafts only, nothing in Jira; ISA cannot create Jira projects. Without a key, lists the Jira projects the owner can see.",
      inputSchema: z.object({ projectId: id.nullable(), key: z.string().nullable().describe("A Jira project key like CHK, \"\" for the default, or null to list them") }),
      run: async ({ projectId, key }) => {
        if (key === null || !projectId) {
          const list = await jiraProjectChoices();
          return list.length ? `Jira projects: ${list.map((p) => `${p.key} (${p.name})`).join(", ")}` : "Jira is not connected, or no projects are visible.";
        }
        const k = key.trim().toUpperCase();
        if (k) {
          const r = await adoptJiraProject(k, { projectId });
          if (!r.ok) return `${r.error} Visible: ${(await jiraProjectChoices()).map((p) => p.key).join(", ") || "none"}.`;
          return `Saved: new tickets for this project go to ${r.key}.${r.moved ? ` Moved ${r.moved} waiting ${r.moved === 1 ? "step" : "steps"} in the inbox there.` : ""}`;
        }
        const r = await setJiraKey(projectId, k);
        return r.ok ? `Saved: new tickets for this project go to ${r.key ?? `the default (${defaultJiraKey() ?? "not set"})`}.` : r.error;
      },
    }),
    tool({
      name: "save_person",
      description:
        "Save what the owner tells you about someone: what they do, their team, and any number of duties, each on a project or company-wide. Use only the owner's own words, not facts from items (ISA suggests those separately for the owner to accept).",
      inputSchema: z.object({
        name: z.string(),
        email: z.string().nullable(),
        title: z.string().nullable().describe("What they do"),
        team: z.string().nullable(),
        duties: z
          .array(z.object({ text: z.string().describe("e.g. 'Approves scope changes', 'PCI compliance'"), projectId: z.string().nullable().describe("The project it applies to, or null for company-wide") }))
          .describe("Duties to add; [] for none"),
      }),
      run: async (input) => {
        const person = await upsertPerson({ name: input.name, email: input.email });
        await updatePerson(person.id, { title: input.title ?? undefined, team: input.team ?? undefined });
        for (const d of input.duties) await addDuty({ personId: person.id, projectId: d.projectId, text: d.text });
        return `Saved ${person.name}${input.duties.length ? ` with ${input.duties.length} duties` : ""}.`;
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
