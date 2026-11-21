import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { processEvent } from "@/lib/brain/pipeline";
import type { StructuredLLM } from "@/lib/brain/llm";
import { projectBlock } from "@/lib/brain/context";
import { acceptSuggestion, addProjectPeople, directory, dismissSuggestion, pendingSuggestions, stakeholders, upsertPerson } from "@/lib/people";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.personSuggestions);
  await db.delete(schema.projectPeople);
  await db.delete(schema.people);
  await db.delete(schema.reminders);
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

async function itemSaying(content: string) {
  const [e] = await db
    .insert(schema.events)
    .values({ source: "zoom", externalId: crypto.randomUUID(), title: "Checkout sync", occurredAt: new Date("2026-11-20T15:00:00Z"), content })
    .returning();
  return e;
}

describe("people directory", () => {
  it("matches people by email, then name, and fills gaps without overwriting", async () => {
    const a = await upsertPerson({ name: "Carla Mendes", title: "Head of Payments" });
    const b = await upsertPerson({ name: "carla mendes", email: "carla@example.com", title: "Intern" });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe("carla@example.com");
    expect(b.title).toBe("Head of Payments");
    const c = await upsertPerson({ name: "C. Mendes", email: "CARLA@example.com" });
    expect(c.id).toBe(a.id);
  });

  it("links a plan's people to the project and shows them to Claude with their role", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    await addProjectPeople(project.id, [{ name: "Ana Costa", email: null, slackUserId: "U1", role: "Approves design" }]);
    await addProjectPeople(project.id, [{ name: "Ana Costa", email: null, slackUserId: null, role: "Something else" }]);
    const team = await stakeholders(project.id);
    expect(team.map((p) => [p.name, p.role])).toEqual([["Ana Costa", "Approves design"]]);
    expect(await projectBlock(project.id)).toContain("Ana Costa (on this project: Approves design");
  });

  it("turns what ISA hears into suggestions that change nothing until accepted", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
    await upsertPerson({ name: "Carla Mendes" });
    const e = await itemSaying("Carla runs payments and knows PCI inside out. Bruno signs off checkout scope.");
    const llm: StructuredLLM = async () =>
      ({
        matches: [],
        newProject: null,
        ignore: true,
        searchTerms: [],
        reason: "",
        commitments: [],
        peopleNotes: [
          { name: "Carla Mendes", email: "", kind: "role", text: "Head of Payments", projectId: "", quote: "Carla runs payments" },
          { name: "Carla Mendes", email: "", kind: "can_help", text: "PCI compliance", projectId: "", quote: "knows PCI inside out" },
          { name: "Bruno Lima", email: "", kind: "moves_project", text: "Signs off checkout scope", projectId: project.id, quote: "Bruno signs off checkout scope" },
          { name: "Nobody", email: "", kind: "moves_project", text: "Unknown project", projectId: "not-a-project", quote: "" },
        ],
      }) as never;
    await processEvent(e.id, llm);
    await processEvent(e.id, llm);

    const pending = await pendingSuggestions();
    expect(pending.map((s) => s.text).sort()).toEqual(["Head of Payments", "PCI compliance", "Signs off checkout scope"]);
    expect((await directory()).map((p) => p.name)).toEqual(["Carla Mendes"]);

    const byText = new Map(pending.map((s) => [s.text, s]));
    await acceptSuggestion(byText.get("PCI compliance")!.id);
    await acceptSuggestion(byText.get("Signs off checkout scope")!.id, "Signs off checkout scope and budget");
    await dismissSuggestion(byText.get("Head of Payments")!.id);

    const people = await directory();
    const carla = people.find((p) => p.name === "Carla Mendes")!;
    expect(carla.canHelpWith).toEqual(["PCI compliance"]);
    expect(carla.title).toBeNull();
    expect((await stakeholders(project.id)).map((p) => [p.name, p.role])).toEqual([["Bruno Lima", "Signs off checkout scope and budget"]]);
    expect(await pendingSuggestions()).toEqual([]);
    expect((await directory("pci")).map((p) => p.name)).toEqual(["Carla Mendes"]);
  });
});
