import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { chatTools } from "./chat-tools";
import { claudeStructured, MODEL } from "./llm";
import { ROLE } from "./prompts";

const CHAT_SYSTEM = `${ROLE}

You are talking with the owner in ISA's chat. The owner uses it to guide you: correct a draft, move an item to the right project, set a rule, or ask what you know.

- Look things up with your tools before answering; do not guess ids.
- You can change drafts, projects and rules. You never send anything to Jira, Slack or email yourself: approved proposals in the inbox do that. When you revise or create a proposal, tell the owner it is waiting in the inbox.
- Say where your answer comes from. When you decline or cannot do something, explain why in one sentence with what you checked (e.g. "I checked Jira just now and SCRUM-5 still exists"), then say exactly what the owner can reply to go ahead.
- When you mention a Jira ticket, give its key and its link, e.g. "SCRUM-12 (https://...)". Use only links your tools returned.
- To answer about a meeting, read its transcript with get_item rather than guessing from the title.
- When the owner asks about a topic, research Jira first with research_jira (it also finds tickets ISA did not create), and say what you found, with ticket keys and links.
- Answer in a few plain sentences. No headings.`;

/** Send the owner's message to ISA, run any tools it uses, and store the conversation. Returns ISA's reply. */
export async function sendChat(text: string): Promise<string> {
  const history = await db.query.chatMessages.findMany({ orderBy: asc(schema.chatMessages.createdAt) });
  try {
    return await runChat(text, replayable(history));
  } catch (err) {
    // A stored conversation the API no longer accepts must not lock the chat: retry with its text only.
    console.error("chat failed, retrying with text only", { error: errorKind(err) });
    return await runChat(text, textOnly(history));
  }
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

async function runChat(text: string, messages: BetaMessageParam[]): Promise<string> {
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
    system: [{ type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } }],
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

/** The conversation as the owner sees it: only the text, without tool calls. */
export async function chatTranscript(): Promise<{ id: string; role: "user" | "assistant"; text: string }[]> {
  const rows = await db.query.chatMessages.findMany({ orderBy: asc(schema.chatMessages.createdAt) });
  return rows.flatMap((m) => {
    const blocks = m.content as { type: string; text?: string }[];
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text ? [{ id: m.id, role: m.role as "user" | "assistant", text }] : [];
  });
}

export async function clearChat() {
  await db.delete(schema.chatMessages);
}
