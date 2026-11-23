import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db, schema } from "@/db";
import type { Plan } from "@/lib/plan";
import { decisionList, decisionTrail, memoryStats, trailText } from "@/lib/trail";
import { cleanMermaid, drawDiagram } from "@/lib/brain/diagram";
import type { StructuredLLM } from "@/lib/brain/llm";
import { importPage, pageIdFrom, plain } from "@/lib/confluence";

beforeAll(async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
});

beforeEach(async () => {
  await db.delete(schema.diagrams);
  await db.delete(schema.ticketChanges);
  await db.delete(schema.proposals);
  await db.delete(schema.projects);
  await db.delete(schema.events);
});

afterEach(() => vi.unstubAllEnvs());

const plan = (over: Partial<Plan>): Plan => ({ summary: "", projectName: null, people: [], requirementChanges: [], actions: [], openQuestions: [], ...over });

async function setup() {
  const [project] = await db.insert(schema.projects).values({ name: "Checkout" }).returning();
  const [req] = await db
    .insert(schema.requirements)
    .values({ projectId: project.id, title: "Guest checkout", status: "approved", approvedBy: "Rafael", jiraIssueKey: "CHK-14" })
    .returning();
  const mk = (source: "zoom" | "slack" | "confluence", title: string, daysAgo: number, extra = {}) =>
    db
      .insert(schema.events)
      .values({ source, externalId: crypto.randomUUID(), title, author: "Rafael", occurredAt: new Date(Date.now() - daysAgo * 86400000), content: "…", status: "sorted", ...extra })
      .returning()
      .then((r) => r[0]);
  const prd = await mk("confluence", "Checkout PRD", 20, {
    sortResult: { matches: [{ projectId: project.id, relation: "context", confidence: "high", requirementIds: [req.id], note: "" }], newProject: null, ignore: false, searchTerms: [], reason: "" },
  });
  const kickoff = await mk("zoom", "Kickoff", 14);
  const weekly = await mk("zoom", "Weekly", 1);
  await db.insert(schema.eventProjects).values({ eventId: kickoff.id, projectId: project.id, relation: "approval", note: "Rafael approved guest checkout" });
  await db.insert(schema.proposals).values([
    {
      kind: "update", projectId: project.id, title: "Kickoff", status: "executed", decidedAt: new Date(Date.now() - 13 * 86400000), eventIds: [kickoff.id], refs: { R1: req.id },
      plan: plan({ requirementChanges: [{ ref: "R1", op: "create", title: "Guest checkout", description: "", status: "approved", approvedBy: "Rafael", reason: "Half of abandoned carts happen at sign-up" }] }),
    },
    { kind: "update", projectId: project.id, title: "Add Pix", status: "pending", eventIds: [weekly.id], plan: plan({ actions: [{ type: "jira_comment", requirementRef: "R", issueKey: "CHK-14", body: "Pix" }] }) },
    { kind: "update", projectId: project.id, title: "Unrelated", status: "executed", eventIds: [weekly.id], plan: plan({ actions: [{ type: "jira_comment", requirementRef: "R", issueKey: "CHK-99", body: "x" }] }) },
  ]);
  await db.insert(schema.ticketChanges).values({ key: "CHK-14", projectId: project.id, historyId: "h1", field: "status", fromValue: "To do", toValue: "In progress", author: "João", changedAt: new Date(), byIsa: "no" });
  return { project, req, prd };
}

describe("decision trail", () => {
  it("tells how a requirement came to be, oldest first, with its sources", async () => {
    const { req } = await setup();
    const t = (await decisionTrail(req.id))!;
    expect(t.entries.map((e) => [e.kind, e.text])).toEqual([
      ["discussed", "Came up in Checkout PRD"],
      ["decided", "Added: Guest checkout, approved by Rafael"],
      ["pending", "Add Pix"],
      ["jira", "João changed the status of CHK-14 in Jira to In progress"],
    ]);
    expect(t.entries[1].reason).toBe("Half of abandoned carts happen at sign-up");
    expect(t.entries[1].sources.map((s) => [s.title, s.note])).toEqual([["Kickoff", "Rafael approved guest checkout"]]);
    expect(trailText(t)).toContain('zoom "Kickoff" by Rafael');
  });

  it("finds decisions by words and counts what is in memory", async () => {
    const { req } = await setup();
    expect((await decisionList({ query: "guest" })).map((r) => r.id)).toEqual([req.id]);
    expect((await decisionList({ query: "chk-14" })).map((r) => r.id)).toEqual([req.id]);
    expect(await decisionList({ query: "nothing like this" })).toEqual([]);
    const stats = await memoryStats();
    expect([stats.meetings, stats.confluence, stats.decisions]).toEqual([2, 1, 1]);
  });
});

describe("diagrams", () => {
  it("saves a drawing from a requirement, without anything that could run in the browser", async () => {
    const { project, req } = await setup();
    let context = "";
    const llm: StructuredLLM = async (r) => {
      context = r.context;
      return { title: "Guest checkout", mermaid: '```mermaid\nflowchart TD\n  A["Start"] --> B["Pay"]\n  click A "javascript:alert(1)"\n```', notes: "Pix open" } as never;
    };
    const d = await drawDiagram(llm, { projectId: project.id, requirementId: req.id, kind: "flow" });
    expect(d.mermaid).toBe('flowchart TD\n  A["Start"] --> B["Pay"]');
    expect(context).toContain("Half of abandoned carts");
    expect(cleanMermaid("flowchart TD\n  A[\"<b>x</b>\"]")).toBe('flowchart TD\n  A["x"]');
  });
});

describe("confluence", () => {
  it("reads page ids from links and turns storage HTML into text", () => {
    expect(pageIdFrom("https://x.atlassian.net/wiki/spaces/CHK/pages/131073/Checkout+PRD")).toBe("131073");
    expect(pageIdFrom("https://x.atlassian.net/wiki/pages/viewpage.action?pageId=42")).toBe("42");
    expect(pageIdFrom("not a page")).toBeNull();
    expect(plain("<h1>Goal</h1><p>Raise conversion &amp; trust</p><ul><li>Guest</li><li>Cards</li></ul>")).toBe("Goal\nRaise conversion & trust\n- Guest\n- Cards");
  });

  it("adds a page version to memory once", async () => {
    vi.stubEnv("JIRA_SITE", "x.atlassian.net");
    vi.stubEnv("JIRA_EMAIL", "a@example.com");
    vi.stubEnv("JIRA_API_TOKEN", "t");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "7", title: "PRD", version: { number: 2, createdAt: "2026-11-01T10:00:00Z" }, body: { storage: { value: "<p>Scope</p>" } }, _links: { webui: "/spaces/X/pages/7" } })));
    vi.stubGlobal("fetch", fetchMock);
    const first = await importPage("https://x.atlassian.net/wiki/spaces/X/pages/7/PRD");
    const again = await importPage("7");
    vi.unstubAllGlobals();
    expect([first.added, again.added]).toEqual([true, false]);
    const [e] = await db.select().from(schema.events);
    expect([e.source, e.title, e.content, e.url, e.status]).toEqual(["confluence", "PRD", "Scope", "https://x.atlassian.net/wiki/spaces/X/pages/7", "new"]);
  });
});
