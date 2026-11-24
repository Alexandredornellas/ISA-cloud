import { sql } from "drizzle-orm";
import { db } from "@/db";

// Tables whose rows show up on screen. Each contributes its row count (catches deletes) and its
// latest change time. worker_state and connections are left out: the worker touches them on every
// pass, which would refresh the page for nothing. Jira tickets use Jira's own change time, because
// every sync pass rewrites the local snapshot.
const TRACKED = [
  "projects",
  "requirements",
  "events",
  "proposals",
  "actions",
  "project_rules",
  "chat_messages",
  "meeting_bots",
  "ticket_changes",
  "reminders",
  "people",
  "person_duties",
  "person_suggestions",
  "diagrams",
] as const;

/**
 * A short fingerprint of everything the app shows. It changes whenever a row is added, changed or
 * removed, so the browser can refresh only when there is something new. Holds counts and times only.
 */
export async function liveStamp(): Promise<string> {
  const parts = TRACKED.map((t) => sql.raw(`select '${t}' as t, count(*)::text as n, coalesce(max(updated_at), 'epoch')::text as at from ${t}`));
  parts.push(sql.raw(`select 'event_projects' as t, count(*)::text as n, '' as at from event_projects`));
  parts.push(sql.raw(`select 'requirement_versions' as t, count(*)::text as n, '' as at from requirement_versions`));
  parts.push(
    sql.raw(
      `select 'jira_tickets' as t, count(*)::text || '/' || count(deleted_at)::text as n, coalesce(max(jira_updated_at), 'epoch')::text as at from jira_tickets`,
    ),
  );
  const rows = (await db.execute(sql.join(parts, sql.raw(" union all ")))) as unknown as { t: string; n: string; at: string }[];
  const text = [...rows]
    .sort((a, b) => a.t.localeCompare(b.t))
    .map((r) => `${r.t}:${r.n}:${r.at}`)
    .join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
