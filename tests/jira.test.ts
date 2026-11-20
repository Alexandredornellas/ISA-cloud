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
    await expect(jira.issueTypeId("ISA", "Spike")).rejects.toThrow('has no issue type "Spike". Its types are: Épico, História, Tarefa');
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
