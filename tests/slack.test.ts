import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import type { SlackConversation, SlackMessage } from "@/lib/slack";
import { pollSlack, readable, resetSlackCache } from "@/lib/slack-poll";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  resetSlackCache();
  await db.delete(schema.workerState);
  await db.delete(schema.meetingBots);
  await db.delete(schema.proposals);
  await db.delete(schema.events);
});

const NOW = 1_800_000_000_000; // ms
const ts = (secondsAgo: number) => (NOW / 1000 - secondsAgo).toFixed(6);
const USERS: Record<string, string> = { U1: "Alexandre", U2: "Ana" };

function fakeSlack(convs: SlackConversation[], history: Record<string, SlackMessage[]>, threads: Record<string, SlackMessage[]> = {}) {
  return {
    conversations: async () => convs,
    history: async (ch: string) => history[ch] ?? [],
    replies: async (_ch: string, root: string) => threads[root] ?? [],
    user: async (id: string) => ({ id, name: USERS[id] ?? id, email: id === "U2" ? "ana@x.com" : null }),
  };
}

describe("pollSlack", () => {
  it("groups new messages into one event per thread and skips bots", async () => {
    const root = ts(600);
    const slack = fakeSlack(
      [{ id: "C1", name: "login" }],
      {
        C1: [
          { ts: ts(100), user: "U1", text: "MFA should also allow SMS <@U2>" },
          { ts: ts(110), bot_id: "B1", text: "ISA here" },
          { ts: ts(5), user: "U1", text: "too recent, waits to settle" },
          { ts: root, user: "U2", text: "Login spec", reply_count: 2, latest_reply: ts(50) },
        ],
      },
      {
        [root]: [
          { ts: root, user: "U2", text: "Login spec" },
          { ts: ts(60), user: "U2", text: "Approved" },
          { ts: ts(50), user: "U2", text: "Ship it" },
        ],
      },
    );

    expect(await pollSlack(slack, NOW)).toBe(2);

    const events = await db.select().from(schema.events);
    const top = events.find((e) => e.replyTo?.threadTs === ts(100))!;
    expect(top).toMatchObject({ source: "slack", author: "Alexandre", replyTo: { channel: "C1", threadTs: ts(100) } });
    // The message just before it in the channel comes along, so short replies keep their meaning.
    expect(top.content).toBe("Slack conversation: #login\nEarlier in this conversation:\nAna: Login spec\nNew messages:\nAlexandre: MFA should also allow SMS @Ana");
    expect(top.participants.map((p) => p.slackUserId).sort()).toEqual(["U1", "U2"]);

    const thread = events.find((e) => e.replyTo?.threadTs === root)!;
    expect(thread.content).toBe("Slack conversation: #login\nAna: Login spec\nAna: Approved\nAna: Ship it");

    // A second pass finds nothing new; the recent message is picked up once it settles.
    expect(await pollSlack(slack, NOW)).toBe(0);
    expect(await pollSlack(slack, NOW + 30_000)).toBe(1);
  });

  it("picks up a message its author edited after ISA read it", async () => {
    const msg: SlackMessage = { ts: ts(300), user: "U2", text: "Stacking is max 2 days" };
    const slack = fakeSlack([{ id: "C1", name: "rewards" }], { C1: [msg] });
    expect(await pollSlack(slack, NOW)).toBe(1);

    // Ana edits it 2 minutes later; ISA sees it once the edit settles, and only once.
    msg.text = "Stacking is max 1 day";
    msg.edited = { user: "U2", ts: ts(-120) };
    const later = NOW + 150_000;
    expect(await pollSlack(slack, later)).toBe(1);
    expect(await pollSlack(slack, later + 30_000)).toBe(0);

    const edited = (await db.select().from(schema.events)).find((e) => e.externalId.includes(":edited:"))!;
    expect(edited.title).toContain("(edited)");
    expect(edited.content).toContain("Edited by its author");
    expect(edited.content).toContain("Ana: Stacking is max 1 day");
  });

  it("puts earlier thread messages in context and DMs the person back", async () => {
    const root = ts(3000);
    const slack = fakeSlack(
      [{ id: "D1", is_im: true, user: "U2" }],
      { D1: [{ ts: root, user: "U2", text: "Old", reply_count: 2, latest_reply: ts(100) }] },
      {
        [root]: [
          { ts: root, user: "U2", text: "Old" },
          { ts: ts(2000), user: "U1", text: "Older reply" },
          { ts: ts(100), user: "U2", text: "New reply" },
        ],
      },
    );
    // ISA has already read this DM up to 30 minutes ago.
    await db.insert(schema.workerState).values({ key: "slack", value: { D1: ts(1800) } });

    await pollSlack(slack, NOW);

    const [e] = await db.select().from(schema.events);
    expect(e.title).toBe("DM with Ana: New reply");
    expect(e.replyTo).toEqual({ channel: "U2" });
    expect(e.content).toBe(
      "Slack conversation: DM with Ana\nEarlier in this thread:\nAna: Old\nAlexandre: Older reply\nNew messages:\nAna: New reply",
    );
  });
});

describe("readable", () => {
  it("turns Slack markup into text", async () => {
    const slack = { user: async (id: string) => ({ id, name: USERS[id] ?? id, email: null }) };
    expect(await readable(slack, "<@U2> see <#C1|login> and <https://x.com|the spec> &amp; <!here>")).toBe(
      "@Ana see #login and the spec (https://x.com) & @here",
    );
  });
});
