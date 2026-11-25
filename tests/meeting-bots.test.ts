import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { meetingKey } from "@/lib/recall";
import { botAlreadyFor, leaveMeeting } from "@/lib/meeting-bots";
import { redraftOf } from "@/lib/channels";
import type { Plan } from "@/lib/plan";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.meetingBots);
});

const ZOOM = "https://us02web.zoom.us/j/123456?pwd=abc";

async function bot(values: Partial<typeof schema.meetingBots.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.meetingBots)
    .values({ recallBotId: `bot-${Math.random()}`, meetingUrl: ZOOM, title: "Demo", platform: "zoom", joinAt: new Date(), ...values })
    .returning();
  return row;
}

describe("meetingKey", () => {
  it("ignores the query and a trailing slash", () => {
    expect(meetingKey(ZOOM)).toBe(meetingKey("https://US02web.zoom.us/j/123456/?pwd=other&from=cal"));
    expect(meetingKey(ZOOM)).not.toBe(meetingKey("https://us02web.zoom.us/j/999"));
  });
});

describe("botAlreadyFor", () => {
  it("finds a bot in the same meeting, whatever the link's query", async () => {
    await bot({ status: "in_call" });
    expect(await botAlreadyFor("https://us02web.zoom.us/j/123456", new Date())).toMatchObject({ status: "in_call" });
  });

  it("finds a bot scheduled for the same time", async () => {
    const at = new Date(Date.now() + 5 * 60_000);
    await bot({ status: "scheduled", joinAt: at });
    expect(await botAlreadyFor(ZOOM, new Date())).not.toBeNull();
  });

  it("lets the same link be used for a later meeting, and ignores finished bots", async () => {
    await bot({ status: "scheduled", joinAt: new Date(Date.now() + 24 * 3600_000) });
    await bot({ status: "done" });
    expect(await botAlreadyFor(ZOOM, new Date())).toBeNull();
    expect(await botAlreadyFor("https://meet.google.com/abc-defg-hij", new Date())).toBeNull();
  });
});

describe("leaveMeeting", () => {
  it("asks Recall to leave and waits for the transcript", async () => {
    const row = await bot({ status: "in_call" });
    const left: string[] = [];
    await leaveMeeting(row.id, { leaveCall: async (id) => void left.push(id) });
    expect(left).toEqual([row.recallBotId]);
    const after = await db.query.meetingBots.findFirst({ where: eq(schema.meetingBots.id, row.id) });
    expect(after?.status).toBe("processing");
  });

  it("refuses when the bot is not in a call", async () => {
    const row = await bot({ status: "done" });
    await expect(leaveMeeting(row.id, { leaveCall: async () => {} })).rejects.toThrow("not in this call");
  });
});

describe("redraftOf", () => {
  const create = (ref: string, summary: string, description: string) =>
    ({ type: "jira_create", requirementRef: ref, summary, description, kind: "story", epicRef: null }) as Plan["actions"][number];
  const plan = (actions: Plan["actions"]): Plan => ({ summary: "", projectName: null, people: [], requirementChanges: [], actions, openQuestions: [] });

  it("is empty for a draft that was never redrafted", () => {
    expect(redraftOf(plan([create("R1", "Export", "CSV")]), null)).toEqual({});
  });

  it("marks changed and added steps, and leaves unchanged ones out", () => {
    const before = plan([create("R1", "Export", "CSV only"), create("R2", "Login", "SSO")]);
    const after = plan([create("R1", "Export", "CSV and PDF"), create("R2", "Login", "SSO"), create("R3", "Audit log", "Keep 90 days")]);
    expect(redraftOf(after, before)).toEqual({ 0: { summary: "Export", description: "CSV only" }, 2: "new" });
  });
});
