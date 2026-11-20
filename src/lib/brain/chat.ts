import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { chatTools } from "./chat-tools";
import { projectBlock } from "./context";
import { claudeStructured, MODEL } from "./llm";

const CHAT_SYSTEM = `You are ISA, the owner's AI business analyst and personal secretary, built on Claude. The owner is usually a developer: requirements reach them from meetings, email and Slack, and you centralize those requirements and the reasoning behind them in Jira. In this chat you are a full assistant: answer any question the way Claude would, with real reasoning and expertise, whether it is about the owner's projects or anything else (writing, analysis, product and engineering questions, planning, explanations).

What makes you different from a plain chat: you can look at everything ISA has gathered for the owner. Meeting transcripts, emails and Slack messages are filed under projects, with their requirements, people, rules, Jira tickets, the tickets' change history, and the proposals waiting in the inbox. You can also search all of Jira by topic.

How to work:
- When a question touches the owner's work, look it up with your tools before answering, and ground your answer in what you found. Do not guess ids, ticket keys, names or decisions. Use several tools when needed: e.g. read the project, read the meeting transcript with get_item, and research Jira for the topic.
- Say where your answer comes from ("In the Nov 20 meeting, Ana said...", "I checked Jira just now and SCRUM-5 still exists"). If something is missing or you could not check it, say so plainly.
- When you decline or cannot do something, explain why in a sentence, with what you checked, and say exactly what the owner can reply to go ahead.
- Act like a professional analyst: point out gaps, risks, conflicts and follow-ups the owner should know about, and suggest next steps.
- You can change drafts, projects and rules. You never send anything to Jira, Slack or email yourself: approved proposals in the inbox do that. When you create or revise a proposal, say it is waiting in the inbox.
- When you mention a Jira ticket, give its key with its link, e.g. "SCRUM-12 (https://...)". Use only links your tools returned.
- Write in Markdown. Fit the length to the question: a short answer for a simple question, structure (short headings, lists, tables) for a longer one.`;

/** Send the owner's message to ISA, run any tools it uses, and store the conversation. Returns ISA's reply. */
export async function sendChat(text: string, projectId: string | null = null): Promise<string> {
  const history = await db.query.chatMessages.findMany({ where: inChat(projectId), orderBy: asc(schema.chatMessages.createdAt) });
  try {
    return await runChat(text, replayable(history), projectId);
  } catch (err) {
    // A stored conversation the API no longer accepts must not lock the chat: retry with its text only.
    console.error("chat failed, retrying with text only", { error: errorKind(err) });
    return await runChat(text, textOnly(history), projectId);
  }
}

/** Each project has its own conversation; projectId null is the general one. */
function inChat(projectId: string | null) {
  return projectId ? eq(schema.chatMessages.projectId, projectId) : isNull(schema.chatMessages.projectId);
}

type StoredMessage = { role: string; content: unknown };
type Block = Record<string, unknown> & { type: string };

function errorKind(err: unknown) {
  return err instanceof Anthropic.APIError ? `${err.name} ${err.status}` : err instanceof Error ? err.name : "unknown";
}

/** Keep only the fields the API accepts on each stored block, so replaying the history stays valid. */
export function replayable(history: StoredMessage[]): BetaMessageParam[] {
  const clean = (b: Block): Block | null => {
    switch (b.type) {
      case "text":
        return { type: "text", text: String(b.text ?? "") };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
      case "tool_result": {
        const content = Array.isArray(b.content) ? (b.content as Block[]).map(clean).filter((x): x is Block => !!x) : (b.content ?? "");
        return { type: "tool_result", tool_use_id: b.tool_use_id, content, ...(b.is_error ? { is_error: true } : {}) };
      }
      default:
        return null; // thinking and other blocks are not needed to continue the conversation
    }
  };
  const out = history.map((m) => {
    const blocks = (Array.isArray(m.content) ? (m.content as Block[]) : [{ type: "text", text: String(m.content) }]).map(clean).filter((x): x is Block => !!x);
    return { role: m.role, content: blocks.length ? blocks : [{ type: "text", text: "(no text)" }] } as BetaMessageParam;
  });
  return out;
}

/** The conversation as plain text turns, without tool calls. */
export function textOnly(history: StoredMessage[]): BetaMessageParam[] {
  const turns: BetaMessageParam[] = [];
  for (const m of history) {
    const text = (Array.isArray(m.content) ? (m.content as Block[]) : [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => String(b.text))
      .join("\n")
      .trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.role === m.role) (last.content as Block[])[0].text += `\n${text}`;
    else turns.push({ role: m.role as "user" | "assistant", content: [{ type: "text", text }] });
  }
  if (turns[0]?.role === "assistant") turns.shift();
  if (turns.at(-1)?.role === "user") turns.pop();
  return turns;
}

async function runChat(text: string, messages: BetaMessageParam[], projectId: string | null): Promise<string> {
  const start = messages.length;
  messages.push({ role: "user", content: [{ type: "text", text }] });

  const { liveSenders } = await import("@/lib/senders");
  const jira = liveSenders().jira;
  const tools = chatTools(claudeStructured, jira, jira).map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      run: async (args: unknown) => {
        try {
          return await t.run(args as never);
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      },
    }),
  );

  const client = new Anthropic();
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    max_iterations: 12,
    thread: false,
    system: [
      { type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } },
      ...(projectId ? [{ type: "text" as const, text: await projectFocus(projectId) }] : []),
    ],
    messages,
    tools,
    output_config: { effort: "medium" },
  });
  const final = await runner.runUntilDone();

  // The runner's messages hold the whole exchange, including tool calls and results.
  const all = [...runner.params.messages];
  const last = all.at(-1);
  if (!last || last.role !== "assistant") all.push({ role: "assistant", content: final.content } as BetaMessageParam);
  // If ISA stopped mid-way (for example at max_iterations), drop unanswered tool calls so the
  // stored conversation stays valid for the next turn.
  const tail = all.at(-1)!;
  if (tail.role === "assistant" && Array.isArray(tail.content)) {
    const kept = tail.content.filter((b) => b.type !== "tool_use");
    all[all.length - 1] = { role: "assistant", content: kept.length ? kept : [{ type: "text", text: "(ISA stopped before finishing.)" }] } as BetaMessageParam;
  }
  const fresh = all.slice(start);
  const base = Date.now();
  await db.insert(schema.chatMessages).values(
    fresh.map((m, i) => ({
      projectId,
      role: m.role,
      content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
      // Keep the order stable: rows inserted together otherwise share a timestamp.
      createdAt: new Date(base + i),
    })),
  );

  return final.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

const TOOL_LABEL: Record<string, string> = {
  list_projects: "projects",
  get_project: "project and Jira check",
  list_project_items: "project items",
  get_item: "full transcript or message",
  search_items: "meetings, emails and Slack",
  research_jira: "Jira search",
  ticket_history: "Jira change history",
  list_pending_proposals: "inbox",
};

/**
 * The conversation as the owner sees it: the text, plus what ISA looked at to answer
 * (shown under each answer, so the owner can tell where it comes from).
 */
export async function chatTranscript(projectId: string | null = null): Promise<{ id: string; role: "user" | "assistant"; text: string; used: string[] }[]> {
  const rows = await db.query.chatMessages.findMany({ where: inChat(projectId), orderBy: asc(schema.chatMessages.createdAt) });
  const out: { id: string; role: "user" | "assistant"; text: string; used: string[] }[] = [];
  let used: string[] = [];
  for (const m of rows) {
    const blocks = m.content as { type: string; text?: string; name?: string }[];
    for (const b of blocks) if (b.type === "tool_use" && b.name) used.push(TOOL_LABEL[b.name] ?? b.name.replace(/_/g, " "));
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) continue;
    const role = m.role as "user" | "assistant";
    if (role === "user") used = [];
    const prev = out.at(-1);
    if (role === "assistant" && prev?.role === "assistant") {
      prev.text += `\n\n${text}`;
      prev.used = [...new Set([...prev.used, ...used])];
    } else {
      out.push({ id: m.id, role, text, used: role === "assistant" ? [...new Set(used)] : [] });
    }
    if (role === "assistant") used = [];
  }
  return out;
}

export async function clearChat(projectId: string | null = null) {
  await db.delete(schema.chatMessages).where(inChat(projectId));
}

/** The project a project chat is about, as ISA knows it now. */
async function projectFocus(projectId: string): Promise<string> {
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project) return "";
  return `This conversation is about the project "${project.name}" (id ${project.id}). Unless the owner says otherwise, every question refers to it. Its current state in ISA (check Jira with your tools before relying on ticket details):\n${await projectBlock(projectId)}`;
}
