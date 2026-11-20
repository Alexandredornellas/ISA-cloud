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

/** The Jira project has no ticket type with this name. ISA asks the owner what to use instead. */
export class MissingIssueTypeError extends Error {
  constructor(
    readonly projectKey: string,
    readonly wanted: string,
    readonly available: string[],
  ) {
    super(`Jira project ${projectKey} has no ticket type "${wanted}". Its types are: ${available.join(", ")}.`);
    this.name = "MissingIssueTypeError";
  }
}

export type JiraIssueState = { key: string; summary: string; status: string; done: boolean };

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
    const issueTypeId = await this.issueTypeId(projectKey, input.issueType);
    const labels = input.labels ?? [];
    const out = await this.request<{ key: string }>("POST", "/issue", {
      fields: {
        project: { key: projectKey },
        summary: input.summary.slice(0, 254),
        issuetype: { id: issueTypeId },
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

  /** Move a ticket to the first status in Jira's "done" category its workflow allows. */
  async closeIssue(key: string): Promise<string> {
    const out = await this.request<{ transitions: { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } }[] }>(
      "GET",
      `/issue/${encodeURIComponent(key)}/transitions`,
    );
    const done = out.transitions.find((t) => t.to?.statusCategory?.key === "done");
    if (!done) throw new Error(`Jira offers no way to close ${key} from its current status`);
    await this.request("POST", `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: done.id } });
    return done.to?.name ?? done.name;
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

  /** Every ticket in a Jira project (up to `limit`), with its status. */
  async projectIssues(projectKey: string, limit = 1000): Promise<JiraIssueState[]> {
    const out: JiraIssueState[] = [];
    let nextPageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        jql: `project = "${projectKey.replace(/"/g, "")}" ORDER BY created DESC`,
        maxResults: "100",
        fields: "summary,status",
      });
      if (nextPageToken) params.set("nextPageToken", nextPageToken);
      const page = await this.request<{
        issues: { key: string; fields: { summary: string; status?: { name: string; statusCategory?: { key: string } } } }[];
        nextPageToken?: string;
      }>("GET", `/search/jql?${params}`);
      for (const i of page.issues) {
        out.push({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status?.name ?? "",
          done: i.fields.status?.statusCategory?.key === "done",
        });
      }
      nextPageToken = page.nextPageToken;
    } while (nextPageToken && out.length < limit);
    return out;
  }

  private issueTypes = new Map<string, ProjectIssueType[]>();

  /**
   * The id of a project's issue type, matched by its English name or by the name shown in the
   * site's language (a Portuguese site calls Story "História" and Task "Tarefa").
   */
  async issueTypeId(projectKey: string, wanted: string): Promise<string> {
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
    if (!match) throw new MissingIssueTypeError(projectKey, wanted, types.map((t) => t.name));
    return match.id;
  }

  /** False when the ticket was deleted (or never existed). */
  async issueExists(key: string): Promise<boolean> {
    try {
      await this.request("GET", `/issue/${encodeURIComponent(key)}?fields=summary`);
      return true;
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return false;
      throw err;
    }
  }

  private accountId: string | null = null;

  /** The Jira account ISA signs in with. */
  async myAccountId(): Promise<string> {
    if (!this.accountId) this.accountId = (await this.request<{ accountId: string }>("GET", "/myself")).accountId;
    return this.accountId;
  }

  private sprintField: string | null | undefined;

  /** The id of the site's Sprint field (a custom field), or null when the site has none. */
  async sprintFieldId(): Promise<string | null> {
    if (this.sprintField === undefined) {
      const fields = await this.request<{ id: string; name: string; schema?: { custom?: string } }[]>("GET", "/field");
      this.sprintField =
        fields.find((f) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")?.id ??
        fields.find((f) => f.name.toLowerCase() === "sprint")?.id ??
        null;
    }
    return this.sprintField;
  }

  /** The full current state of these tickets. Tickets missing from the answer were deleted. */
  async ticketDetails(keys: string[]): Promise<TicketDetail[]> {
    const sprintField = await this.sprintFieldId().catch(() => null);
    const fields = ["summary", "description", "status", "assignee", "labels", "parent", "issuetype", "updated", ...(sprintField ? [sprintField] : [])];
    const out: TicketDetail[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const batch = keys.slice(i, i + 50).filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k));
      if (!batch.length) continue;
      let nextPageToken: string | undefined;
      do {
        const params = new URLSearchParams({ jql: `key in (${batch.join(",")})`, maxResults: "100", fields: fields.join(",") });
        if (nextPageToken) params.set("nextPageToken", nextPageToken);
        const page = await this.request<{ issues: { key: string; fields: Record<string, unknown> }[]; nextPageToken?: string }>(
          "GET",
          `/search/jql?${params}`,
        );
        for (const issue of page.issues) out.push(ticketDetail(issue.key, issue.fields, sprintField));
        nextPageToken = page.nextPageToken;
      } while (nextPageToken);
    }
    return out;
  }

  /**
   * Tickets in any project whose title, description or comments mention one of these terms,
   * most recently updated first, with their latest comments.
   */
  async searchText(terms: string[], limit = 10): Promise<FoundTicket[]> {
    const clean = [...new Set(terms.map((t) => t.replace(/["\\[\](){}*?~^!:+\-&|/]/g, " ").replace(/\s+/g, " ").trim()).filter((t) => t.length > 1))].slice(0, 5);
    if (!clean.length) return [];
    const sprintField = await this.sprintFieldId().catch(() => null);
    const fields = ["summary", "description", "status", "assignee", "labels", "parent", "issuetype", "updated", "comment", ...(sprintField ? [sprintField] : [])];
    const params = new URLSearchParams({
      jql: `${clean.map((t) => `text ~ "${t}"`).join(" OR ")} ORDER BY updated DESC`,
      maxResults: String(limit),
      fields: fields.join(","),
    });
    const page = await this.request<{ issues: { key: string; fields: Record<string, unknown> }[] }>("GET", `/search/jql?${params}`);
    return page.issues.map((i) => {
      const comments = ((i.fields.comment as { comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[] })?.comments ?? [])
        .slice(-3)
        .map((c) => ({ author: c.author?.displayName ?? null, at: c.created ? new Date(c.created) : null, text: adfToText(c.body) }));
      return { ...ticketDetail(i.key, i.fields, sprintField), url: this.issueUrl(i.key), comments };
    });
  }

  /** A ticket's change history, oldest first: who changed which field, from what, to what, and when. */
  async changelog(key: string): Promise<ChangelogEntry[]> {
    const out: ChangelogEntry[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.request<{
        values: {
          id: string;
          created: string;
          author?: { displayName?: string; accountId?: string };
          items: { field: string; fromString?: string | null; toString?: string | null }[];
        }[];
        isLast?: boolean;
        total?: number;
      }>("GET", `/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`);
      for (const v of page.values) {
        out.push({
          id: v.id,
          at: new Date(v.created),
          author: v.author?.displayName ?? null,
          authorAccountId: v.author?.accountId ?? null,
          items: v.items.map((it) => ({ field: it.field, from: it.fromString ?? null, to: it.toString ?? null })),
        });
      }
      startAt += page.values.length;
      if (page.isLast !== false || !page.values.length) break;
    }
    return out;
  }

  async checkProject(): Promise<{ key: string; name: string }> {
    const p = await this.request<{ key: string; name: string }>(
      "GET",
      `/project/${encodeURIComponent(this.cfg.projectKey)}`,
    );
    return { key: p.key, name: p.name };
  }
}

export type TicketDetail = {
  key: string;
  issueType: string | null;
  summary: string;
  description: string;
  status: string | null;
  assignee: string | null;
  sprint: string | null;
  epic: string | null;
  labels: string[];
  updated: Date | null;
};

export type FoundTicket = TicketDetail & {
  url: string;
  comments: { author: string | null; at: Date | null; text: string }[];
};

export type ChangelogEntry = {
  id: string;
  at: Date;
  author: string | null;
  authorAccountId: string | null;
  items: { field: string; from: string | null; to: string | null }[];
};

function ticketDetail(key: string, f: Record<string, unknown>, sprintField: string | null): TicketDetail {
  const named = (v: unknown, prop = "name") => (v && typeof v === "object" ? ((v as Record<string, unknown>)[prop] as string) ?? null : null);
  const sprints = (sprintField ? f[sprintField] : null) as { name: string; state?: string }[] | null;
  const sprint = Array.isArray(sprints) && sprints.length ? (sprints.find((s) => s.state === "active") ?? sprints.at(-1)!).name : null;
  const parent = f.parent as { key: string; fields?: { summary?: string } } | undefined;
  return {
    key,
    issueType: named(f.issuetype),
    summary: (f.summary as string) ?? "",
    description: adfToText(f.description),
    status: named(f.status),
    assignee: named(f.assignee, "displayName"),
    sprint,
    epic: parent ? `${parent.key}${parent.fields?.summary ? ` ${parent.fields.summary}` : ""}` : null,
    labels: Array.isArray(f.labels) ? (f.labels as string[]) : [],
    updated: typeof f.updated === "string" ? new Date(f.updated) : null,
  };
}

/** Plain text from an Atlassian Document Format value. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfToText);
  if (n.type === "listItem") return `- ${inner.join("").trim()}\n`;
  if (n.type === "doc") return inner.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (n.type === "paragraph" || n.type === "heading" || n.type === "bulletList" || n.type === "orderedList") return `${inner.join("")}\n`;
  return inner.join("");
}

/** The browser link of a ticket on the configured Jira site. */
export function jiraBrowseUrl(key: string): string {
  const site = process.env.JIRA_SITE?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return site ? `https://${site}/browse/${key}` : key;
}
