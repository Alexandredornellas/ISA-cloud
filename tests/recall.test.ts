import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { botState, formatTranscript, platformOf, RecallClient, type BotState } from "@/lib/recall";
import { pollBots } from "@/lib/worker";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

describe("platformOf", () => {
  it("recognises meeting links", () => {
    expect(platformOf("https://us02web.zoom.us/j/123")).toBe("zoom");
    expect(platformOf("https://meet.google.com/abc-defg-hij")).toBe("meet");
    expect(platformOf("https://teams.microsoft.com/l/meetup-join/x")).toBe("teams");
    expect(platformOf("https://evilzoom.us/j/1")).toBeNull();
    expect(platformOf("not a url")).toBeNull();
  });
});

describe("botState", () => {
  it("maps Recall statuses", () => {
    expect(botState({ status_changes: [{ code: "ready" }] }).status).toBe("scheduled");
    expect(botState({ status_changes: [{ code: "in_waiting_room" }] })).toMatchObject({
      status: "in_call",
      detail: "Waiting to be admitted",
    });
    expect(botState({ status_changes: [{ code: "fatal", sub_code: "meeting_not_found" }] })).toMatchObject({
      status: "failed",
      detail: "meeting_not_found",
    });
    expect(botState({ status_changes: [{ code: "done" }], recordings: [] }).status).toBe("failed");
    expect(
      botState({ status_changes: [{ code: "done" }], recordings: [{ media_shortcuts: { transcript: { status: { code: "processing" } } } }] })
        .status,
    ).toBe("processing");
    expect(
      botState({
        status_changes: [{ code: "done" }],
        recordings: [{ media_shortcuts: { transcript: { status: { code: "done" }, data: { download_url: "https://t" } } } }],
      }),
    ).toEqual({ status: "done", detail: null, transcriptUrl: "https://t" });
  });
});

describe("formatTranscript", () => {
  it("joins consecutive words per speaker", () => {
    const out = formatTranscript([
      { participant: { name: "Ana" }, words: [{ text: "We" }, { text: "need" }] },
      { participant: { name: "Ana" }, words: [{ text: "MFA." }] },
      { participant: { name: null }, words: [{ text: "Agreed." }] },
    ]);
    expect(out.text).toBe("Ana: We need MFA.\nUnknown speaker: Agreed.");
    expect(out.speakers).toEqual(["Ana", "Unknown speaker"]);
  });
});

describe("pollBots", () => {
  beforeEach(async () => {
    await db.delete(schema.meetingBots);
    await db.delete(schema.events);
  });

  function fakeRecall(state: BotState) {
    return {
      getBotState: async () => state,
      downloadTranscript: async () => [{ participant: { name: "Ana" }, words: [{ text: "Hello" }] }],
    } as unknown as RecallClient;
  }

  it("stores the finished transcript as a new event", async () => {
    await db.insert(schema.meetingBots).values({
      recallBotId: "bot1",
      meetingUrl: "https://meet.google.com/x",
      title: "Kickoff",
      platform: "meet",
      joinAt: new Date(),
      status: "in_call",
    });

    const stored = await pollBots(fakeRecall({ status: "done", detail: null, transcriptUrl: "https://t" }));

    expect(stored).toBe(1);
    const [event] = await db.select().from(schema.events);
    expect(event).toMatchObject({ source: "meet", externalId: "bot1", title: "Kickoff", content: "Ana: Hello", status: "new" });
    const [bot] = await db.select().from(schema.meetingBots);
    expect(bot).toMatchObject({ status: "done", eventId: event.id });
  });

  it("skips bots that start later and records state changes", async () => {
    await db.insert(schema.meetingBots).values([
      { recallBotId: "later", meetingUrl: "u", title: "Later", platform: "zoom", joinAt: new Date(Date.now() + 3_600_000) },
      { recallBotId: "now", meetingUrl: "u", title: "Now", platform: "zoom", joinAt: new Date() },
    ]);

    await pollBots(fakeRecall({ status: "in_call", detail: "Waiting to be admitted", transcriptUrl: null }));

    const bots = await db.select().from(schema.meetingBots);
    const byId = Object.fromEntries(bots.map((b) => [b.recallBotId, b]));
    expect(byId.later.status).toBe("scheduled");
    expect(byId.now).toMatchObject({ status: "in_call", error: "Waiting to be admitted" });
  });
});
