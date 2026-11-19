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
    const f = fakeFetch([{ status: 201, body: { key: "ISA-7" } }]);
    const issue = await new JiraClient(cfg, f.impl).createIssue({
      summary: "Login page",
      description: "Text",
      issueType: "Story",
    });
    expect(issue).toEqual({ key: "ISA-7", url: "https://acme.atlassian.net/browse/ISA-7" });
    expect(f.calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.fields.project.key).toBe("ISA");
    expect(body.fields.issuetype.name).toBe("Story");
    expect(String((f.calls[0].init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
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
