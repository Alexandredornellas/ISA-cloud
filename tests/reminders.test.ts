import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import { processEvent } from "@/lib/brain/pipeline";
import type { StructuredLLM } from "@/lib/brain/llm";
import { addReminder, bucketOf, dueCount, dueFrom, openReminders, remindersText, setReminderStatus } from "@/lib/reminders";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.reminders);
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

describe("reminders from items", () => {
  it("saves what the owner promised, once, even when the item is read again", async () => {
    const [project] = await db.insert(schema.projects).values({ name: "MFA login" }).returning();
    const [e] = await db
      .insert(schema.events)
      .values({ source: "zoom", externalId: crypto.randomUUID(), title: "Weekly", occurredAt: new Date("2026-11-20T15:00:00Z"), content: "I'll send Ana the mockups by Monday." })
      .returning();
    const llm: StructuredLLM = async () =>
      ({
        matches: [],
        newProject: null,
        ignore: true,
        searchTerms: [],
        reason: "",
        commitments: [
          { what: "Send the MFA mockups", owedBy: "", forWhom: "Ana", due: "2026-11-23", dueText: "by Monday", quote: "I'll send Ana the mockups by Monday", projectId: project.id },
          { what: "Confirm the schema", owedBy: "Weslei", forWhom: "", due: "", dueText: "", quote: "I'll confirm the schema", projectId: "" },
        ],
      }) as never;
    await processEvent(e.id, llm);
    await processEvent(e.id, llm);
    const all = await openReminders();
    expect(all.map((r) => [r.text, r.direction, r.person])).toEqual([
      ["Send the MFA mockups", "mine", "Ana"],
      ["Confirm the schema", "theirs", "Weslei"],
    ]);
    const open = all.filter((r) => r.direction === "mine");
    expect(open[0]).toMatchObject({ text: "Send the MFA mockups", person: "Ana", dueText: "by Monday", projectName: "MFA login", source: { title: "Weekly" } });
    expect(await openReminders(project.id)).toHaveLength(1);
  });
});

describe("reminder dates", () => {
  const now = new Date("2026-11-20T18:00:00Z"); // Friday afternoon in Fortaleza
  it("groups by when they are due, in the owner's time zone", () => {
    expect(bucketOf({ due: dueFrom("2026-11-19") }, now)).toBe("overdue");
    expect(bucketOf({ due: dueFrom("2026-11-20") }, now)).toBe("today");
    expect(bucketOf({ due: dueFrom("2026-11-25") }, now)).toBe("week");
    expect(bucketOf({ due: dueFrom("2026-12-20") }, now)).toBe("later");
    expect(bucketOf({ due: null }, now)).toBe("undated");
    expect(dueFrom("tomorrow")).toBeNull();
  });

  it("counts what is due or overdue, and forgets what is done", async () => {
    const a = await addReminder({ text: "Send the API docs", person: "Bruno", due: "2026-11-19" });
    await addReminder({ text: "Review the spec", due: "2026-12-30" });
    expect(await dueCount(now)).toBe(1);
    expect(remindersText(await openReminders(), now)).toContain("Send the API docs (for Bruno) due 2026-11-19 OVERDUE");
    await setReminderStatus(a.id, "done");
    expect(await dueCount(now)).toBe(0);
  });
});
