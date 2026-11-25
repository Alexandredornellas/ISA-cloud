import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { placeClarification, processEvent } from "@/lib/brain/pipeline";
import { projectBlock } from "@/lib/brain/context";
import { mergeProjectInto } from "@/lib/project-merge";
import { byEpic } from "@/components/ProjectPanels";
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

const plan: Plan = {
  summary: "Google sign-in",
  projectName: null,
  people: [],
  requirementChanges: [
    { ref: "R1", op: "create", title: "Sign in with Google", description: "", status: "proposed", approvedBy: null, reason: "", epic: "login" },
  ],
  actions: [],
  openQuestions: [],
};

function scripted(sort: SortResult): StructuredLLM {
  return async (req) => (req.system.includes("decide where one new item belongs") ? sort : plan) as never;
}

async function addEvent(title = "Google login") {
  const [e] = await db
    .insert(schema.events)
    .values({ source: "slack", externalId: `${title}-${Math.random()}`, title, occurredAt: new Date(), content: "Let players sign in with Google" })
    .returning();
  return e;
}

async function addProject(name: string) {
  const [p] = await db.insert(schema.projects).values({ name }).returning();
  return p;
}

describe("epics inside a project", () => {
  it("saves the epic of each new requirement, reusing the project's spelling", async () => {
    const game = await addProject("Need for Speed 8 game");
    await db.insert(schema.requirements).values({ projectId: game.id, title: "Email sign-in", epic: "Login" });
    const e = await addEvent();
    const llm = scripted({
      matches: [{ projectId: game.id, relation: "new", confidence: "high", requirementIds: [], note: "New in epic Login: Google sign-in" }],
      newProject: null,
      ignore: false,
      searchTerms: [],
      reason: "",
    });

    await processEvent(e.id, llm);

    const reqs = await db.select().from(schema.requirements).where(eq(schema.requirements.projectId, game.id));
    expect(reqs.map((r) => r.epic)).toEqual(["Login", "Login"]);
    // ISA sees the project's epics when it sorts and drafts.
    const block = await projectBlock(game.id);
    expect(block).toContain("Epics (feature areas inside this project): Login");
    expect(block).toContain("(epic: Login, status: proposed");
  });

  it("asks before starting a new project when the owner already has projects", async () => {
    const game = await addProject("Need for Speed 8 game");
    const e = await addEvent();
    const llm = scripted({ matches: [], newProject: { name: "ISA login with Google", reason: "Looks like new work" }, ignore: false, searchTerms: [], reason: "" });

    const out = await processEvent(e.id, llm);

    expect(out.kind).toBe("unsure");
    expect(await db.select().from(schema.projects)).toHaveLength(1);
    const [card] = await db.select().from(schema.proposals);
    expect(card).toMatchObject({ kind: "clarify", projectId: null });
    expect(card.plan.projectName).toBe("ISA login with Google");

    // The owner puts it in the game instead: no new project, the item and its requirement land there.
    await placeClarification(card.id, { projectId: game.id }, llm);
    expect(await db.select().from(schema.projects)).toHaveLength(1);
    expect(await db.select().from(schema.eventProjects)).toMatchObject([{ eventId: e.id, projectId: game.id }]);
    const [req] = await db.select().from(schema.requirements);
    expect(req).toMatchObject({ projectId: game.id, epic: "login" });
  });

  it("merges a project into another as an epic, keeping everything ISA knew", async () => {
    const game = await addProject("Need for Speed 8 game");
    const login = await addProject("ISA login with Google");
    const [r] = await db.insert(schema.requirements).values({ projectId: login.id, title: "Sign in with Google" }).returning();
    const e = await addEvent();
    const shared = await addEvent("Planning");
    await db.insert(schema.eventProjects).values([
      { eventId: e.id, projectId: login.id, relation: "new" },
      { eventId: shared.id, projectId: login.id, relation: "context" },
      { eventId: shared.id, projectId: game.id, relation: "context" },
    ]);
    await db.insert(schema.proposals).values({ kind: "update", projectId: login.id, title: "Changes", plan });
    const [todo] = await db.insert(schema.reminders).values({ projectId: login.id, text: "Send mockups", eventId: e.id }).returning();

    const out = await mergeProjectInto(login.id, game.id, "LOGIN");

    expect(out).toEqual({ requirements: 1, items: 2 });
    expect(await db.select({ id: schema.projects.id }).from(schema.projects)).toEqual([{ id: game.id }]);
    expect(await db.query.requirements.findFirst({ where: eq(schema.requirements.id, r.id) })).toMatchObject({ projectId: game.id, epic: "LOGIN" });
    const links = await db.select().from(schema.eventProjects);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.projectId === game.id)).toBe(true);
    expect((await db.select().from(schema.proposals))[0].projectId).toBe(game.id);
    expect((await db.query.reminders.findFirst({ where: eq(schema.reminders.id, todo.id) }))?.projectId).toBe(game.id);
    await expect(mergeProjectInto(game.id, game.id, "x")).rejects.toThrow();
  });

  it("groups requirements by epic, with the ones without an epic last", () => {
    const groups = byEpic([
      { id: "1", epic: null },
      { id: "2", epic: "Login" },
      { id: "3", epic: "Checkout" },
      { id: "4", epic: "Login" },
    ]);
    expect(groups.map((g) => [g.epic, g.items.map((i) => i.id)])).toEqual([
      ["Login", ["2", "4"]],
      ["Checkout", ["3"]],
      ["No epic yet", ["1"]],
    ]);
  });
});
