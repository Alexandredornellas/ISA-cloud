// Confluence, read-only, with the same Atlassian sign-in as Jira (JIRA_SITE, JIRA_EMAIL,
// JIRA_API_TOKEN). ISA searches pages for answers and can add a page to its memory, where it is
// sorted into projects like any meeting, email or Slack message. It never writes to Confluence.
import { db, schema } from "@/db";

type Config = { site: string; auth: string };

function config(): Config | null {
  const { JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_SITE || !JIRA_EMAIL || !JIRA_API_TOKEN) return null;
  return {
    site: JIRA_SITE.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    auth: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`,
  };
}

export const confluenceConfigured = () => config() !== null;

async function get<T>(path: string): Promise<T> {
  const c = config();
  if (!c) throw new Error("Confluence uses the Jira sign-in: set JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN");
  const res = await fetch(`https://${c.site}/wiki${path}`, { headers: { Authorization: c.auth, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Confluence answered ${res.status}${res.status === 404 ? ": page not found, or Confluence is not on this Atlassian site" : ""}`);
  return (await res.json()) as T;
}

export type PageHit = { id: string; title: string; excerpt: string; url: string; updated: string | null; space: string | null };

/** Escape a phrase for a CQL string. */
const cql = (s: string) => s.replace(/["\\]/g, " ").trim();

/** Pages matching words, best first. */
export async function searchPages(query: string, limit = 8): Promise<PageHit[]> {
  const c = config();
  const q = cql(query);
  if (!c || !q) return [];
  const data = await get<{ results: { content?: { id: string; title: string }; excerpt?: string; url?: string; lastModified?: string; resultGlobalContainer?: { title?: string } }[] }>(
    `/rest/api/search?limit=${limit}&cql=${encodeURIComponent(`type = page AND text ~ "${q}"`)}`,
  );
  return data.results
    .filter((r) => r.content)
    .map((r) => ({
      id: r.content!.id,
      title: r.content!.title,
      excerpt: plain(r.excerpt ?? "").slice(0, 300),
      url: `https://${c.site}/wiki${r.url ?? `/pages/viewpage.action?pageId=${r.content!.id}`}`,
      updated: r.lastModified ?? null,
      space: r.resultGlobalContainer?.title ?? null,
    }));
}

export type Page = { id: string; title: string; text: string; url: string; version: number; updated: Date };

export async function getPage(id: string): Promise<Page> {
  const c = config()!;
  const p = await get<{ id: string; title: string; version?: { number: number; createdAt?: string }; body?: { storage?: { value?: string } }; _links?: { webui?: string } }>(
    `/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`,
  );
  return {
    id: p.id,
    title: p.title,
    text: plain(p.body?.storage?.value ?? ""),
    url: `https://${c?.site}/wiki${p._links?.webui ?? `/pages/viewpage.action?pageId=${p.id}`}`,
    version: p.version?.number ?? 1,
    updated: p.version?.createdAt ? new Date(p.version.createdAt) : new Date(),
  };
}

/** A page id from a Confluence link (…/pages/123456/Title) or a bare id. */
export function pageIdFrom(input: string): string | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return s;
  return s.match(/\/pages\/(\d+)/)?.[1] ?? s.match(/pageId=(\d+)/)?.[1] ?? null;
}

/** Add a page (this version) to ISA's memory; the worker sorts it into projects. */
export async function importPage(input: string): Promise<{ eventId: string; title: string; added: boolean }> {
  const id = pageIdFrom(input);
  if (!id) throw new Error("Paste a Confluence page link, like https://your-site.atlassian.net/wiki/spaces/X/pages/123456/Title");
  const page = await getPage(id);
  const [row] = await db
    .insert(schema.events)
    .values({
      source: "confluence",
      externalId: `${page.id}@${page.version}`,
      title: page.title,
      occurredAt: page.updated,
      content: page.text.slice(0, 40_000) || "(empty page)",
      url: page.url,
    })
    .onConflictDoNothing()
    .returning({ id: schema.events.id });
  return { eventId: row?.id ?? "", title: page.title, added: !!row };
}

/** Storage-format HTML to readable text. */
export function plain(html: string): string {
  return html
    .replace(/<(br|\/p|\/h\d|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** For the Connections page: can ISA read Confluence on this site? */
export async function confluenceStatus(): Promise<{ ok: boolean; detail: string }> {
  if (!confluenceConfigured()) return { ok: false, detail: "Uses the Jira sign-in: set JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN" };
  try {
    const data = await get<{ results: { name: string }[] }>("/api/v2/spaces?limit=5");
    return { ok: true, detail: data.results.length ? `Read-only. Spaces: ${data.results.map((s) => s.name).join(", ")}` : "Read-only. No spaces visible to this account yet" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Not connected" };
  }
}
