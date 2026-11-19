import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { cleanSort, confirmClarification, processEvent } from "@/lib/brain/pipeline";
import type { StructuredLLM } from "@/lib/brain/llm";
import type { Plan, SortResult } from "@/lib/plan";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

/** A fake Claude that answers sort and propose calls from scripted values, and records the calls. */
function scripted(sort: SortResult, plan: Plan) {
  const calls: { system: string; context: string; input: string }[] = [];
  const llm: StructuredLLM = async (req) => {
    calls.push(req);
    return (req.system.includes("decide where one new item belongs") ? sort : plan) as never;
  };
  return { llm, calls };
}

const plan: Plan = {
  summary: "Summary",
  projectName: "Login",
  people: [],
  requirementChanges: [
    { ref: "R1", op: "create", title: "MFA", description: "", status: "proposed", approvedBy: null, reason: "" },
  ],
  actions: [
    { type: "jira_create", requirementRef: "R1", summary: "MFA", description: "", issueType: "Story" },
    { type: "slack_message", channel: "", recipientLabel: "nobody", threadTs: null, text: "hi" },
  ],
  openQuestions: [],
};

async function addEvent(title = "Kickoff") {
  const [e] = await db
    .insert(schema.events)
    .values({
      source: "slack",
      externalId: `${title}-${Math.random()}`,
      title,
      occurredAt: new Date(),
      content: "We need MFA on login",
      replyTo: { channel: "C123", threadTs: "1.2" },
    })
    .returning();
  return e;
}

async function addProject(name = "Login") {
  const [p] = await db.insert(schema.projects).values({ name }).returning();
  return p;
}

describe("processEvent", () => {
  it("proposes a new project when nothing matches", async () => {
    const e = await addEvent();
    const { llm, calls } = scripted(
      { matches: [], newProject: { name: "Login", reason: "new work" }, ignore: false, reason: "" },
      plan,
    );

    const out = await processEvent(e.id, llm);

    expect(out.kind).toBe("filed");
    const proposals = await db.select().from(schema.proposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("new_project");
    expect(proposals[0].title).toBe("New project: Login");
    // The empty Slack message was dropped; the Jira ticket kept.
    expect(proposals[0].plan.actions.map((a) => a.type)).toEqual(["jira_create"]);
    // Claude saw where to reply on the same channel.
    expect(calls[1].input).toContain("channel=C123");
  });

  it("files a confident match and drafts that project's update", async () => {
    const p = await addProject();
    const e = await addEvent("Change");
    const { llm } = scripted(
      {
        matches: [{ projectId: p.id, relation: "change", confidence: "high", requirementIds: [], note: "MFA now SMS" }],
        newProject: null,
        ignore: false,
        reason: "",
      },
      { ...plan, projectName: "ignored for updates" },
    );

    await processEvent(e.id, llm);

    const proposals = await db.select().from(schema.proposals);
    expect(proposals.map((x) => [x.kind, x.projectId, x.plan.projectName])).toEqual([["update", p.id, null]]);
    const links = await db.select().from(schema.eventProjects);
    expect(links).toMatchObject([{ projectId: p.id, relation: "change", note: "MFA now SMS" }]);
    const saved = await db.query.events.findFirst({ where: eq(schema.events.id, e.id) });
    expect(saved?.status).toBe("sorted");
  });

  it("drafts one update per project when an item touches two", async () => {
    const a = await addProject("Login");
    const b = await addProject("Billing");
    const e = await addEvent("Sync call");
    const { llm } = scripted(
      {
        matches: [
          { projectId: a.id, relation: "change", confidence: "high", requirementIds: [], note: "a" },
          { projectId: b.id, relation: "new", confidence: "high", requirementIds: [], note: "b" },
        ],
        newProject: null,
        ignore: false,
        reason: "",
      },
      plan,
    );

    await processEvent(e.id, llm);

    const proposals = await db.select().from(schema.proposals);
    expect(proposals.map((x) => x.projectId).sort()).toEqual([a.id, b.id].sort());
  });

  it("asks the owner when unsure, and drafts the update after a yes", async () => {
    const p = await addProject();
    const e = await addEvent("Maybe");
    const { llm } = scripted(
      {
        matches: [{ projectId: p.id, relation: "change", confidence: "medium", requirementIds: [], note: "Might be MFA" }],
        newProject: null,
        ignore: false,
        reason: "",
      },
      plan,
    );

    const out = await processEvent(e.id, llm);
    expect(out.kind).toBe("unsure");
    const [question] = await db.select().from(schema.proposals);
    expect(question.kind).toBe("clarify");
    expect(question.title).toBe('Is "Maybe" about Login?');

    const updateId = await confirmClarification(question.id, llm);

    expect(updateId).not.toBeNull();
    const saved = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, question.id) });
    expect(saved?.status).toBe("executed");
    const ev = await db.query.events.findFirst({ where: eq(schema.events.id, e.id) });
    expect(ev?.status).toBe("sorted");
  });

  it("ignores unrelated items", async () => {
    const e = await addEvent("Lunch?");
    const { llm } = scripted({ matches: [], newProject: null, ignore: true, reason: "small talk" }, plan);

    expect(await processEvent(e.id, llm)).toEqual({ kind: "ignored" });
    expect(await db.select().from(schema.proposals)).toHaveLength(0);
  });

  it("marks the event failed when Claude fails", async () => {
    const e = await addEvent();
    const llm: StructuredLLM = async () => {
      throw new Error("overloaded");
    };
    await expect(processEvent(e.id, llm)).rejects.toThrow("overloaded");
    const saved = await db.query.events.findFirst({ where: eq(schema.events.id, e.id) });
    expect(saved?.status).toBe("failed");
  });
});

describe("cleanSort", () => {
  it("drops unknown and repeated projects", () => {
    const m = { relation: "new" as const, confidence: "high" as const, requirementIds: [], note: "" };
    const out = cleanSort(
      {
        matches: [
          { ...m, projectId: "a" },
          { ...m, projectId: "ghost" },
          { ...m, projectId: "a" },
        ],
        newProject: null,
        ignore: false,
        reason: "",
      },
      new Set(["a"]),
    );
    expect(out.matches.map((x) => x.projectId)).toEqual(["a"]);
  });
});
