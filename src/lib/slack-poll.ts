import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Person } from "@/lib/plan";
import { type SlackClient, type SlackConversation, type SlackMessage } from "@/lib/slack";
import { log } from "@/lib/log";

type Reader = Pick<SlackClient, "conversations" | "history" | "replies" | "user">;

/** On first sight of a conversation, ISA reads back this far. */
const FIRST_LOOK_SECONDS = 60 * 60;
/** Wait this long after a message so a burst of messages becomes one item. */
const SETTLE_SECONDS = 20;
const CONVERSATIONS_TTL_MS = 5 * 60_000;
/** Earlier messages shown with a new top-level message: up to this many, from the last 3 hours. */
const RECENT_MESSAGES = 10;
const RECENT_SECONDS = 3 * 60 * 60;
const STATE_KEY = "slack";

let conversationsCache: { at: number; list: SlackConversation[] } | null = null;

export function resetSlackCache() {
  conversationsCache = null;
}

const tsNum = (ts: string) => Number.parseFloat(ts);

function wanted(m: SlackMessage): boolean {
  if (m.bot_id) return false; // ISA's own posts and other bots
  if (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "file_share") return false;
  return !!m.text?.trim();
}

/**
 * Read new Slack messages since the last pass and store them as events: one event per thread
 * (or top-level message) with new messages, including earlier thread messages for context.
 */
export async function pollSlack(slack: Reader, now = Date.now()): Promise<number> {
  if (!conversationsCache || now - conversationsCache.at > CONVERSATIONS_TTL_MS) {
    conversationsCache = { at: now, list: await slack.conversations() };
  }
  const row = await db.query.workerState.findFirst({ where: eq(schema.workerState.key, STATE_KEY) });
  const cursors: Record<string, string> = { ...(row?.value ?? {}) };
  const nowSec = now / 1000;
  const settle = nowSec - SETTLE_SECONDS;
  let stored = 0;

  for (const conv of conversationsCache.list) {
    try {
      cursors[conv.id] ??= (nowSec - FIRST_LOOK_SECONDS).toFixed(6);
      const cursor = tsNum(cursors[conv.id]);
      const isNew = (m: SlackMessage) => wanted(m) && tsNum(m.ts) > cursor && tsNum(m.ts) <= settle;

      // root ts -> { thread context, new messages }
      const groups = new Map<string, { context: SlackMessage[]; fresh: SlackMessage[] }>();
      const add = (root: string, m: SlackMessage, context: SlackMessage[] = []) => {
        const g = groups.get(root) ?? { context, fresh: [] };
        if (!g.context.length && context.length) g.context = context;
        if (!g.fresh.some((x) => x.ts === m.ts)) g.fresh.push(m);
        groups.set(root, g);
      };

      const history = await slack.history(conv.id);
      // A DM or channel without threads is one running conversation: the messages just before the
      // new ones give a short reply ("on it!", "sounds good, go ahead") its meaning.
      const recentBefore = (ts: string) =>
        history
          .filter((x) => wanted(x) && !x.thread_ts && tsNum(x.ts) < tsNum(ts) && tsNum(x.ts) > tsNum(ts) - RECENT_SECONDS)
          .sort((a, b) => tsNum(a.ts) - tsNum(b.ts))
          .slice(-RECENT_MESSAGES);
      for (const m of history) {
        if (isNew(m)) add(m.thread_ts ?? m.ts, m, m.thread_ts ? [] : recentBefore(m.ts));
        if (m.reply_count && m.latest_reply && tsNum(m.latest_reply) > cursor) {
          const thread = await slack.replies(conv.id, m.ts);
          const fresh = thread.slice(1).filter(isNew);
          const context = thread.filter((x) => wanted(x) && tsNum(x.ts) <= cursor);
          for (const r of fresh) add(m.ts, r, context);
        }
      }

      let maxTs = cursor;
      for (const [root, g] of groups) {
        g.fresh.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
        const last = g.fresh.at(-1)!;
        maxTs = Math.max(maxTs, tsNum(last.ts));
        const inserted = await storeGroup(slack, conv, root, g.context, g.fresh);
        if (inserted) stored += 1;
      }
      cursors[conv.id] = maxTs.toFixed(6);
    } catch (err) {
      log.error("slack poll failed", err, { channel: conv.id });
    }
  }

  await db
    .insert(schema.workerState)
    .values({ key: STATE_KEY, value: cursors })
    .onConflictDoUpdate({ target: schema.workerState.key, set: { value: cursors, updatedAt: new Date() } });
  return stored;
}

async function storeGroup(
  slack: Reader,
  conv: SlackConversation,
  root: string,
  context: SlackMessage[],
  fresh: SlackMessage[],
): Promise<boolean> {
  const people = new Map<string, Person>();
  const nameOf = async (id: string) => {
    const u = await slack.user(id);
    if (!people.has(id)) people.set(id, { name: u.name, email: u.email, slackUserId: id, role: null });
    return u.name;
  };
  const line = async (m: SlackMessage) => {
    // People mentioned in a message are involved too.
    for (const [, id] of (m.text ?? "").matchAll(/<@([A-Z0-9]+)/g)) await nameOf(id);
    return `${m.user ? await nameOf(m.user) : "Someone"}: ${await readable(slack, m.text ?? "")}`;
  };

  const where = conv.is_im
    ? `DM with ${conv.user ? await nameOf(conv.user) : "someone"}`
    : conv.is_mpim
      ? "Group DM"
      : `#${conv.name ?? conv.id}`;

  const parts = [`Slack conversation: ${where}`];
  if (context.length) {
    parts.push(root === fresh[0].ts && !fresh[0].thread_ts ? "Earlier in this conversation:" : "Earlier in this thread:");
    for (const m of context.slice(0, 1).concat(context.slice(1).slice(-9))) parts.push((await line(m)).slice(0, 800));
    parts.push("New messages:");
  }
  for (const m of fresh) parts.push(await line(m));

  const first = await readable(slack, fresh[0].text ?? "");
  const last = fresh.at(-1)!;
  // ISA's bot cannot post in someone else's DM, so it DMs that person instead. Group DMs get no reply target.
  const replyTo: Record<string, string> | null = conv.is_im
    ? conv.user
      ? { channel: conv.user }
      : null
    : conv.is_mpim
      ? null
      : { channel: conv.id, threadTs: root };

  const [row] = await db
    .insert(schema.events)
    .values({
      source: "slack",
      externalId: `${conv.id}:${root}:${last.ts}`,
      title: `${where}: ${first.length > 60 ? `${first.slice(0, 57)}...` : first}`,
      author: fresh[0].user ? await nameOf(fresh[0].user) : null,
      participants: [...people.values()],
      occurredAt: new Date(tsNum(last.ts) * 1000),
      content: parts.join("\n"),
      replyTo,
    })
    .onConflictDoNothing()
    .returning({ id: schema.events.id });
  return !!row;
}

/** Replace Slack markup (<@U1>, <#C1|name>, <url|label>) with readable text. */
export async function readable(slack: Pick<Reader, "user">, text: string): Promise<string> {
  const ids = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, (await slack.user(id)).name);
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
