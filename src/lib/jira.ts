// Minimal Jira Cloud REST v3 client: create, update, comment, search.
// Authenticates with an Atlassian account email and API token.

export type JiraConfig = {
  site: string; // yourname.atlassian.net
  email: string;
  apiToken: string;
  projectKey: string;
};

export type JiraIssue = { key: string; url: string };

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function jiraConfigFromEnv(): JiraConfig {
  const { JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;
  if (!JIRA_SITE || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) {
    throw new Error("Jira is not configured: set JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY");
  }
  return {
    site: JIRA_SITE.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    email: JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
    projectKey: JIRA_PROJECT_KEY,
  };
}

// Atlassian Document Format from plain text. Lines starting with "- " or "* " become bullets.
type AdfNode = Record<string, unknown>;
export function toAdf(text: string): AdfNode {
  const content: AdfNode[] = [];
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      content.push({
        type: "bulletList",
        content: lines.map((l) => ({
          type: "listItem",
          content: [paragraph(l.replace(/^\s*[-*] /, ""))],
        })),
      });
    } else {
      content.push(paragraph(lines.join("\n")));
    }
  }
  if (content.length === 0) content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}

function paragraph(text: string): AdfNode {
  const parts = text.split("\n");
  const inline: AdfNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) inline.push({ type: "hardBreak" });
    if (p) inline.push({ type: "text", text: p });
  });
  return { type: "paragraph", content: inline };
}

type ProjectIssueType = { id: string; name: string; untranslatedName?: string; subtask?: boolean };

// Common translations of Jira's default issue types, for sites not in English.
const TYPE_ALIASES: Record<string, string[]> = {
  story: ["historia", "user story"],
  task: ["tarefa", "tarea", "tache"],
  bug: ["erro", "defeito", "error", "bogue"],
  epic: ["epico", "epica", "epique"],
};

export class JiraClient {
  constructor(
    private readonly cfg: JiraConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get projectKey() {
    return this.cfg.projectKey;
  }

  issueUrl(key: string) {
    return `https://${this.cfg.site}/browse/${key}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString("base64");
    const res = await this.fetchImpl(`https://${this.cfg.site}/rest/api/3${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // Jira returns {errorMessages, errors}; keep it short for the UI.
      const detail = await res.text().catch(() => "");
      throw new JiraError(`Jira ${method} ${path} failed (${res.status}): ${detail.slice(0, 300)}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createIssue(input: {
    summary: string;
    description: string;
    issueType: string;
    labels?: string[];
    projectKey?: string;
  }): Promise<JiraIssue> {
    const projectKey = input.projectKey ?? this.cfg.projectKey;
    const type = await this.issueType(projectKey, input.issueType);
    const labels = [...(input.labels ?? []), ...(type.fallback ? [input.issueType.toLowerCase()] : [])];
    const out = await this.request<{ key: string }>("POST", "/issue", {
      fields: {
        project: { key: projectKey },
        summary: input.summary.slice(0, 254),
        issuetype: { id: type.id },
        description: toAdf(input.description),
        ...(labels.length ? { labels: [...new Set(labels.map((l) => l.trim().replace(/\s+/g, "-")))] } : {}),
      },
    });
    return { key: out.key, url: this.issueUrl(out.key) };
  }

  async updateIssue(key: string, input: { summary?: string | null; description?: string | null }) {
    const fields: Record<string, unknown> = {};
    if (input.summary) fields.summary = input.summary.slice(0, 254);
    if (input.description) fields.description = toAdf(input.description);
    if (Object.keys(fields).length === 0) return;
    await this.request("PUT", `/issue/${encodeURIComponent(key)}`, { fields });
  }

  async addComment(key: string, body: string) {
    await this.request("POST", `/issue/${encodeURIComponent(key)}/comment`, { body: toAdf(body) });
  }

  async search(jql: string, max = 20): Promise<{ key: string; summary: string; status: string }[]> {
    const params = new URLSearchParams({ jql, maxResults: String(max), fields: "summary,status" });
    const out = await this.request<{
      issues: { key: string; fields: { summary: string; status?: { name: string } } }[];
    }>("GET", `/search/jql?${params}`);
    return out.issues.map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name ?? "",
    }));
  }

  // Cheap call that proves the credentials and project key work.
  private issueTypes = new Map<string, ProjectIssueType[]>();

  /**
   * The id of a project's issue type, matched by its English name or by the name shown in the
   * site's language (a Portuguese site calls Story "História" and Task "Tarefa").
   */
  async issueType(projectKey: string, wanted: string): Promise<{ id: string; fallback: boolean }> {
    let types = this.issueTypes.get(projectKey);
    if (!types) {
      const p = await this.request<{ issueTypes?: ProjectIssueType[] }>("GET", `/project/${encodeURIComponent(projectKey)}`);
      types = (p.issueTypes ?? []).filter((t) => !t.subtask);
      this.issueTypes.set(projectKey, types);
    }
    const norm = (v?: string) => (v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
    const target = norm(wanted);
    const aliases = [target, ...(TYPE_ALIASES[target] ?? [])];
    const match =
      types.find((t) => norm(t.untranslatedName) === target || norm(t.name) === target) ??
      types.find((t) => aliases.includes(norm(t.name)) || aliases.includes(norm(t.untranslatedName)));
    if (match) return { id: match.id, fallback: false };
    // The project lacks this type (projects made from some templates have no Story or Bug):
    // use its Task type, then any non-epic type, and keep the intended type as a label.
    const isTask = (t: ProjectIssueType) => [norm(t.untranslatedName), norm(t.name)].some((n) => ["task", ...TYPE_ALIASES.task].includes(n));
    const isEpic = (t: ProjectIssueType) => [norm(t.untranslatedName), norm(t.name)].some((n) => ["epic", ...TYPE_ALIASES.epic].includes(n));
    const fallback = types.find(isTask) ?? types.find((t) => !isEpic(t)) ?? types[0];
    if (!fallback) throw new Error(`Jira project ${projectKey} has no issue types ISA can use`);
    return { id: fallback.id, fallback: true };
  }

  async checkProject(): Promise<{ key: string; name: string }> {
    const p = await this.request<{ key: string; name: string }>(
      "GET",
      `/project/${encodeURIComponent(this.cfg.projectKey)}`,
    );
    return { key: p.key, name: p.name };
  }
}
