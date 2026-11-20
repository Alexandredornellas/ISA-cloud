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
- When you mention a Jira ticket, give its key and its link, e.g. "SCRUM-12 (https://...)". Use only links your tools returned.
- To answer about a meeting, read its transcript with get_item rather than guessing from the title.
- Answer in a few plain sentences. No headings.`;

/** Send the owner's message to ISA, run any tools it uses, and store the conversation. Returns ISA's reply. */
export async function sendChat(text: string): Promise<string> {
  const history = await db.query.chatMessages.findMany({ orderBy: asc(schema.chatMessages.createdAt) });
  const messages = history.map((m) => ({ role: m.role, content: m.content }) as BetaMessageParam);
  const start = messages.length;
  messages.push({ role: "user", content: [{ type: "text", text }] });

  const tools = chatTools(claudeStructured).map((t) =>
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
