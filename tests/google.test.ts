import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { emailEvent, GmailSender, parseAddresses, pollGmail, stripQuoted, type GmailMessage } from "@/lib/gmail";
import { meetingLink, scheduleCalendarBots } from "@/lib/calendar";
import { GoogleError } from "@/lib/google";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.meetingBots);
  await db.delete(schema.proposals);
  await db.delete(schema.events);
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const mail: GmailMessage = {
  id: "m1",
  threadId: "t1",
  internalDate: "1800000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: '"Ana Silva" <Ana@Investor.com>' },
      { name: "To", value: "alex@isa.dev, Bob <bob@x.com>" },
      { name: "Subject", value: "New idea: billing page" },
      { name: "Message-ID", value: "<abc@mail>" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64("We need a billing page.\n\nOn Tue, Alex wrote:\n> old stuff") } },
      { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
    ],
  },
};

/** A fake Google client: answers GET by path and records POSTs. */
function fakeGoogle(routes: Record<string, unknown>, initial: Record<string, string> = {}) {
  let state = { ...initial };
  const posts: { url: string; body: unknown }[] = [];
  return {
    posts,
    currentState: () => state,
    state: async () => state,
    saveState: async (s: Record<string, string>) => {
      state = s;
    },
    get: async <T,>(url: string) => {
      const path = new URL(url).pathname;
      const hit = Object.entries(routes).find(([k]) => path.endsWith(k));
      if (!hit) throw new GoogleError(404, `no route ${path}`);
      return hit[1] as T;
    },
    send: async <T,>(_method: string, url: string, body?: unknown) => {
      posts.push({ url, body });
      return { id: "sent1" } as T;
    },
  };
}

describe("emails", () => {
  it("parses addresses", () => {
    expect(parseAddresses('"Silva, Ana" <ana@x.com>, bob@y.com')).toEqual([
      { name: "Silva, Ana", email: "ana@x.com" },
      { name: "bob@y.com", email: "bob@y.com" },
    ]);
  });

  it("drops quoted replies", () => {
    expect(stripQuoted("Yes, approved.\n\nOn Mon, Nov 20, Ana wrote:\n> Can we?")).toBe("Yes, approved.");
    expect(stripQuoted("Fine\n> quoted\nThanks")).toBe("Fine\nThanks");
  });

  it("turns a message into an event", () => {
    const e = emailEvent(mail);
    expect(e).toMatchObject({
      source: "gmail",
      externalId: "m1",
      title: "New idea: billing page",
      replyTo: { threadId: "t1", to: "ana@investor.com", subject: "New idea: billing page" },
    });
    expect(e.content).toContain("Subject: New idea: billing page\n\nWe need a billing page.");
    expect(e.content).not.toContain("old stuff");
    expect(e.participants.map((p) => p.email)).toEqual(["ana@investor.com", "alex@isa.dev", "bob@x.com"]);
  });

  it("starts from now, then stores new inbox emails", async () => {
    const google = fakeGoogle({
      "/profile": { historyId: "100" },
      "/history": {
        historyId: "105",
        history: [
          { messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] },
          { messagesAdded: [{ message: { id: "spam", labelIds: ["INBOX", "SPAM"] } }] },
        ],
      },
      "/messages/m1": mail,
    });

    expect(await pollGmail(google)).toBe(0);
    expect(google.currentState().historyId).toBe("100");
    expect(await pollGmail(google)).toBe(1);
    expect(google.currentState().historyId).toBe("105");
    expect(await db.select().from(schema.events)).toHaveLength(1);
  });

  it("replies in the thread with reply headers", async () => {
    const google = fakeGoogle({ "/threads/t1": { messages: [mail] } });
    await new GmailSender(google).send({ to: ["ana@investor.com"], subject: "Re: billing", body: "Noted.", threadId: "t1" });
    const body = google.posts[0].body as { raw: string; threadId: string };
    expect(body.threadId).toBe("t1");
    const raw = Buffer.from(body.raw, "base64url").toString("utf8");
    expect(raw).toContain("In-Reply-To: <abc@mail>");
    expect(raw).toContain("To: ana@investor.com");
    expect(raw.endsWith("\r\n\r\nNoted.")).toBe(true);
  });
});

describe("calendar", () => {
  const NOW = Date.parse("2026-11-20T10:00:00Z");
  const items = [
    { id: "a", summary: "Investor call", start: { dateTime: "2026-11-20T11:00:00Z" }, hangoutLink: "https://meet.google.com/abc" },
    { id: "b", summary: "Lunch", start: { dateTime: "2026-11-20T12:00:00Z" } },
    {
      id: "c",
      summary: "Declined",
      start: { dateTime: "2026-11-20T13:00:00Z" },
      location: "https://zoom.us/j/1",
      attendees: [{ self: true, responseStatus: "declined" }],
    },
  ];

  it("finds links in the description", () => {
    expect(meetingLink({ id: "x", description: "Join: https://us02web.zoom.us/j/9?pwd=1 thanks" })).toBe(
      "https://us02web.zoom.us/j/9?pwd=1",
    );
  });

  it("schedules each meeting once, only when auto-join is on", async () => {
    const created: string[] = [];
    const recall = {
      createBot: async (url: string) => {
        created.push(url);
        return { id: `bot-${created.length}` };
      },
    };
    expect(await scheduleCalendarBots(fakeGoogle({ "/events": { items } }), recall, NOW)).toBe(0);

    const google = fakeGoogle({ "/events": { items } }, { autoJoin: "on" });
    expect(await scheduleCalendarBots(google, recall, NOW)).toBe(1);
    expect(await scheduleCalendarBots(google, recall, NOW)).toBe(0);
    expect(created).toEqual(["https://meet.google.com/abc"]);
    const [bot] = await db.select().from(schema.meetingBots);
    expect(bot).toMatchObject({ title: "Investor call", platform: "meet", status: "scheduled" });
  });
});
