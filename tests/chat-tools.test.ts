import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { chatTools } from "@/lib/brain/chat-tools";
import type { StructuredLLM } from "@/lib/brain/llm";
import type { Plan } from "@/lib/plan";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.proposals);
  await db.delete(schema.projectRules);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

const plan = (summary: string): Plan => ({
  summary,
  projectName: "Billing",
  people: [],
  requirementChanges: [{ ref: "R1", op: "create", title: "Invoices", description: "", status: "proposed", approvedBy: null, reason: "" }],
  actions: [{ type: "jira_create", requirementRef: "R1", summary: "Invoices", description: "", kind: "story" }],
  openQuestions: [],
});

function run(name: string, args: unknown, llm: StructuredLLM) {
  const t = chatTools(llm).find((x) => x.name === name)!;
  return t.run(args as never);
}

describe("chat tools", () => {
  it("revises a pending proposal with the owner's correction", async () => {
    const [p] = await db.insert(schema.proposals).values({ kind: "new_project", title: "New project: Billing", plan: plan("v1"), eventIds: [] }).returning();
    let seen = "";
    const llm: StructuredLLM = async (req) => {
      seen = req.input;
      return plan("v2") as never;
    };

    const out = await run("revise_proposal", { proposalId: p.id, instruction: "Call it Payments" }, llm);

    expect(out).toContain("Revised. v2");
    expect(seen).toContain("Call it Payments");
    const saved = await db.query.proposals.findFirst({ where: eq(schema.proposals.id, p.id) });
    expect(saved?.plan.summary).toBe("v2");
  });

  it("moves an item to another project and dismisses the old draft", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Login" }).returning();
    const [e] = await db
      .insert(schema.events)
      .values({ source: "gmail", externalId: "m1", title: "Invoices", occurredAt: new Date(), content: "We need invoices", status: "sorted" })
      .returning();
    const [old] = await db.insert(schema.proposals).values({ kind: "new_project", title: "New project: Billing", plan: plan("old"), eventIds: [e.id] }).returning();

    const out = await run("move_item", { eventId: e.id, projectId: project.id, newProjectName: null }, async () => plan("new") as never);

    expect(out).toMatch(/^Moved\. New proposal/);
    const rows = await db.select().from(schema.proposals);
    expect(rows.find((r) => r.id === old.id)?.status).toBe("dismissed");
    expect(rows.find((r) => r.id !== old.id)).toMatchObject({ kind: "update", projectId: project.id, status: "pending" });
    expect(await db.select().from(schema.eventProjects)).toMatchObject([{ eventId: e.id, projectId: project.id }]);
  });

  it("saves rules and lists projects", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Login" }).returning();
    const llm: StructuredLLM = async () => {
      throw new Error("not used");
    };
    await run("add_project_rule", { projectId: project.id, rule: "Ana approves design" }, llm);
    expect(await run("get_project", { projectId: project.id }, llm)).toContain("Ana approves design");
    expect(await run("list_projects", {}, llm)).toBe(`${project.id}: Login (0 requirements)`);
  });

  it("turns a note into proposals", async () => {
    const llm: StructuredLLM = async (req) =>
      (req.system.includes("decide where one new item belongs")
        ? { matches: [], newProject: { name: "Billing", reason: "new" }, ignore: false, reason: "" }
        : plan("from note")) as never;

    const out = await run("add_note", { title: "Phone call", text: "Ana wants invoices" }, llm);

    expect(out).toContain("New project: Billing");
    const [e] = await db.select().from(schema.events);
    expect(e).toMatchObject({ source: "manual", status: "sorted" });
  });
});
