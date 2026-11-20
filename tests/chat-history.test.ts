import { describe, expect, it } from "vitest";
import { replayable, textOnly } from "@/lib/brain/chat";

const history = [
  { role: "user", content: [{ type: "text", text: "Create the tickets again" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "...", signature: "s" },
      { type: "text", text: "Checking.", citations: null, parsed_output: null },
      { type: "tool_use", id: "t1", name: "get_project", input: { projectId: "p" }, caller: { type: "direct" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Project...", extra: 1 }] },
  { role: "assistant", content: [{ type: "text", text: "They exist." }] },
];

describe("chat history", () => {
  it("replays only the fields the API accepts", () => {
    const out = replayable(history);
    expect(out[1].content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "t1", name: "get_project", input: { projectId: "p" } },
    ]);
    expect(out[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "Project..." }]);
  });

  it("falls back to alternating text turns", () => {
    expect(textOnly(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "Create the tickets again" }] },
      { role: "assistant", content: [{ type: "text", text: "Checking.\nThey exist." }] },
    ]);
  });
});

describe("chat transcript", () => {
  it("shows what ISA looked at under each answer", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await sql.end();
    const { db, schema } = await import("@/db");
    const { chatTranscript } = await import("@/lib/brain/chat");
    await db.delete(schema.chatMessages);
    const base = Date.now();
    await db.insert(schema.chatMessages).values(history.map((m, i) => ({ role: m.role as "user" | "assistant", content: m.content as never, createdAt: new Date(base + i) })));
    const t = await chatTranscript();
    expect(t.map((m) => [m.role, m.text, m.used])).toEqual([
      ["user", "Create the tickets again", []],
      ["assistant", "Checking.\n\nThey exist.", ["project and Jira check"]],
    ]);
    await db.delete(schema.chatMessages);
  });
});

describe("project chats", () => {
  it("keeps each project's conversation apart from the general one", async () => {
    const { db, schema } = await import("@/db");
    const { chatTranscript, clearChat } = await import("@/lib/brain/chat");
    await db.delete(schema.chatMessages);
    const [p] = await db.insert(schema.projects).values({ name: "Login" }).returning();
    const text = (t: string) => [{ type: "text", text: t }];
    await db.insert(schema.chatMessages).values([
      { role: "user", content: text("general question") },
      { role: "user", content: text("login question"), projectId: p.id },
    ]);
    expect((await chatTranscript()).map((m) => m.text)).toEqual(["general question"]);
    expect((await chatTranscript(p.id)).map((m) => m.text)).toEqual(["login question"]);
    await clearChat(p.id);
    expect(await chatTranscript(p.id)).toEqual([]);
    expect(await chatTranscript()).toHaveLength(1);
    await db.delete(schema.chatMessages);
    await db.delete(schema.projects);
  });
});

describe("drafting settings", () => {
  it("defaults to stories under epics, and can be turned off", async () => {
    const { db, schema } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const { getSettings, saveSettings, settingsText } = await import("@/lib/settings");
    await db.delete(schema.workerState).where(eq(schema.workerState.key, "settings"));
    expect(await getSettings()).toEqual({ askEpic: true, askSprint: false, askStoryPoints: false, askLinks: false, askCustom: [], ownerName: "" });
    expect(settingsText(await getSettings())).toContain("every story");
    await saveSettings({ askEpic: false, askSprint: true, askStoryPoints: true, askLinks: false, askCustom: ["Component", " ", "Component", "Due date"], ownerName: " Ana " });
    expect(await getSettings()).toEqual({ askEpic: false, askSprint: true, askStoryPoints: true, askLinks: false, askCustom: ["Component", "Due date"], ownerName: "Ana" });
    const text = settingsText(await getSettings());
    expect(text).toContain("storyPoints");
    expect(text).toContain('"Component", "Due date"');
    expect(text).not.toContain("links:");
    await db.delete(schema.workerState).where(eq(schema.workerState.key, "settings"));
  });
});
