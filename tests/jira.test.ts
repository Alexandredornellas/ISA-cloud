import { describe, expect, it } from "vitest";
import { JiraClient, JiraError, toAdf } from "@/lib/jira";

const cfg = { site: "acme.atlassian.net", email: "a@b.c", apiToken: "t", projectKey: "ISA" };

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("toAdf", () => {
  it("turns paragraphs and dash lists into ADF", () => {
    const doc = toAdf("Intro line\n\n- one\n- two") as { content: { type: string }[] };
    expect(doc.content.map((c) => c.type)).toEqual(["paragraph", "bulletList"]);
  });

  it("never returns an empty document", () => {
    const doc = toAdf("") as { content: unknown[] };
    expect(doc.content).toHaveLength(1);
  });
});

describe("JiraClient", () => {
  it("creates an issue in the configured project", async () => {
    const f = fakeFetch([
      { status: 200, body: { issueTypes: [{ id: "10001", name: "Story" }] } },
      { status: 201, body: { key: "ISA-7" } },
    ]);
    const issue = await new JiraClient(cfg, f.impl).createIssue({
      summary: "Login page",
      description: "Text",
      issueType: "Story",
    });
    expect(issue).toEqual({ key: "ISA-7", url: "https://acme.atlassian.net/browse/ISA-7" });
    expect(f.calls[1].url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    const body = JSON.parse(String(f.calls[1].init.body));
    expect(body.fields.project.key).toBe("ISA");
    expect(body.fields.issuetype).toEqual({ id: "10001" });
    expect(String((f.calls[0].init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
  });

  it("finds issue types on a site in another language", async () => {
    const types = [
      { id: "1", name: "Épico", untranslatedName: "Epic" },
      { id: "2", name: "História" },
      { id: "3", name: "Tarefa" },
      { id: "4", name: "Subtarefa", subtask: true },
    ];
    const f = fakeFetch([{ status: 200, body: { issueTypes: types } }]);
    const jira = new JiraClient(cfg, f.impl);
    expect(await jira.issueTypeId("ISA", "Epic")).toBe("1");
    expect(await jira.issueTypeId("ISA", "Story")).toBe("2");
    expect(await jira.issueTypeId("ISA", "task")).toBe("3");
    await expect(jira.issueTypeId("ISA", "Bug")).rejects.toMatchObject({
      name: "MissingIssueTypeError",
      wanted: "Bug",
      available: ["Épico", "História", "Tarefa"],
    });
    expect(f.calls).toHaveLength(1); // the project's types are fetched once
  });

  it("skips an update with nothing to change", async () => {
    const f = fakeFetch([]);
    await new JiraClient(cfg, f.impl).updateIssue("ISA-1", { summary: null, description: null });
    expect(f.calls).toHaveLength(0);
  });

  it("raises JiraError with the status on failure", async () => {
    const f = fakeFetch([{ status: 400, body: { errorMessages: ["bad"] } }]);
    await expect(new JiraClient(cfg, f.impl).addComment("ISA-1", "hi")).rejects.toBeInstanceOf(JiraError);
  });
});

describe("projectIssues", () => {
  it("pages through a project's tickets", async () => {
    const issue = (key: string, cat: string) => ({ key, fields: { summary: key, status: { name: "S", statusCategory: { key: cat } } } });
    const f = fakeFetch([
      { status: 200, body: { issues: [issue("ISA-2", "indeterminate")], nextPageToken: "p2" } },
      { status: 200, body: { issues: [issue("ISA-1", "done")] } },
    ]);
    const out = await new JiraClient(cfg, f.impl).projectIssues("ISA");
    expect(out.map((i) => [i.key, i.done])).toEqual([
      ["ISA-2", false],
      ["ISA-1", true],
    ]);
    expect(f.calls[1].url).toContain("nextPageToken=p2");
  });
});

describe("ticket tracking reads", () => {
  it("reads a ticket's state, including sprint and epic", async () => {
    const { adfToText } = await import("@/lib/jira");
    const f = fakeFetch([
      { status: 200, body: [{ id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }] },
      {
        status: 200,
        body: {
          issues: [
            {
              key: "ISA-1",
              fields: {
                summary: "Login",
                description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Sign in" }] }] },
                status: { name: "In Progress" },
                assignee: { displayName: "Ana" },
                labels: ["auth"],
                parent: { key: "ISA-0", fields: { summary: "Accounts" } },
                issuetype: { name: "Story" },
                updated: "2026-11-20T10:00:00.000+0000",
                customfield_10020: [{ name: "Sprint 3", state: "closed" }, { name: "Sprint 4", state: "active" }],
              },
            },
          ],
        },
      },
    ]);
    const [t] = await new JiraClient(cfg, f.impl).ticketDetails(["ISA-1"]);
    expect(t).toMatchObject({ key: "ISA-1", description: "Sign in", status: "In Progress", assignee: "Ana", sprint: "Sprint 4", epic: "ISA-0 Accounts", labels: ["auth"] });
    expect(new URL(f.calls[1].url).searchParams.get("jql")).toBe("key in (ISA-1)");
    expect(adfToText(toAdf("A\n\n- one\n- two"))).toBe("A\n\n- one\n- two");
  });

  it("reads the change history across pages", async () => {
    const entry = (id: string) => ({ id, created: "2026-11-20T10:00:00.000+0000", author: { displayName: "Ana", accountId: "a" }, items: [{ field: "status", fromString: "To Do", toString: "Done" }] });
    const f = fakeFetch([
      { status: 200, body: { values: [entry("1")], isLast: false } },
      { status: 200, body: { values: [entry("2")], isLast: true } },
    ]);
    const log = await new JiraClient(cfg, f.impl).changelog("ISA-1");
    expect(log.map((l) => l.id)).toEqual(["1", "2"]);
    expect(log[0].items[0]).toEqual({ field: "status", from: "To Do", to: "Done" });
    expect(f.calls[1].url).toContain("startAt=1");
  });
});

describe("Jira topic research", () => {
  it("searches titles, descriptions and comments for every term", async () => {
    const f = fakeFetch([
      { status: 200, body: [] },
      {
        status: 200,
        body: {
          issues: [
            {
              key: "OPS-3",
              fields: {
                summary: "Two-factor for admins",
                status: { name: "Done" },
                comment: { comments: [{ author: { displayName: "Bo" }, created: "2026-11-01T10:00:00.000+0000", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Shipped" }] }] } }] },
              },
            },
          ],
        },
      },
    ]);
    const found = await new JiraClient(cfg, f.impl).searchText(['MFA', 'two-factor "auth"', "x"]);
    expect(new URL(f.calls[1].url).searchParams.get("jql")).toBe('text ~ "MFA" OR text ~ "two factor auth" ORDER BY updated DESC');
    expect(found[0]).toMatchObject({ key: "OPS-3", status: "Done", url: "https://acme.atlassian.net/browse/OPS-3" });
    expect(found[0].comments[0]).toMatchObject({ author: "Bo", text: "Shipped" });
  });
});

describe("closing a ticket", () => {
  it("moves it to a done status its workflow allows", async () => {
    const f = fakeFetch([
      { status: 200, body: { transitions: [{ id: "11", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }, { id: "31", name: "Finish", to: { name: "Concluído", statusCategory: { key: "done" } } }] } },
      { status: 204 },
    ]);
    expect(await new JiraClient(cfg, f.impl).closeIssue("ISA-2")).toBe("Concluído");
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ transition: { id: "31" } });
  });
});
