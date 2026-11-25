// The home briefing: what needs the owner and what changed, each as one short row.
import { changeParts, type ActivityEntry } from "@/lib/activity";
import type { ProjectHealth, RiskKind } from "@/lib/portfolio";
import type { DiffPart } from "@/lib/diff";
import { sourceOf } from "@/lib/sources";

export type Tone = "danger" | "warn" | "accent" | "neutral";

export type NeedRow = { key: string; tone: Tone; chip: string; text: string; project: string; href: string };

const RISK: Partial<Record<RiskKind, { chip: string; tone: Tone; rank: number }>> = {
  drift: { chip: "Conflict", tone: "danger", rank: 0 },
  overdue: { chip: "Overdue", tone: "danger", rank: 2 },
  no_ticket: { chip: "No ticket", tone: "warn", rank: 4 },
};

/**
 * Everything that waits on the owner, most urgent first: conflicts with Jira, failed steps, late
 * promises, then drafts to approve. A draft shows once, as itself, not again as a "waiting" risk.
 */
export function needRows(projects: ProjectHealth[], unfiled = 0): NeedRow[] {
  const rows: (NeedRow & { rank: number })[] = [];
  for (const p of projects) {
    const href = `/?c=${p.id}`;
    p.risks.forEach((r, i) => {
      const kind = RISK[r.kind];
      if (kind) rows.push({ key: `${p.id}-risk-${i}`, tone: kind.tone, chip: kind.chip, text: r.text, project: p.name, href, rank: kind.rank });
    });
    for (const w of p.waiting) {
      rows.push({
        key: w.id,
        tone: w.failed ? "danger" : "warn",
        chip: w.failed ? "Failed" : "Approve",
        text: w.failed ? `${w.title}: a step failed` : `${w.title}${w.steps ? ` · ${w.steps} step${w.steps === 1 ? "" : "s"} drafted` : ""}`,
        project: p.name,
        href,
        rank: w.failed ? 1 : 3,
      });
    }
  }
  if (unfiled) {
    rows.push({ key: "unfiled", tone: "warn", chip: "File", text: `${unfiled} item${unfiled === 1 ? "" : "s"} ISA could not place in a project`, project: "", href: "/inbox?show=needs_you", rank: 5 });
  }
  return rows.sort((a, b) => a.rank - b.rank).map((r) => ({ key: r.key, tone: r.tone, chip: r.chip, text: r.text, project: r.project, href: r.href }));
}

export type ChangeRow = {
  key: string;
  /** ISO time, so the browser can tell what is new since the last visit. */
  at: string;
  tone: Tone;
  chip: string;
  /** What changed, in bold: a ticket key and field, or a requirement. */
  lead: string | null;
  /** Before → after, when ISA has both values. */
  parts: DiffPart[] | null;
  /** Shown when there is no before → after. */
  text: string;
  project: string;
  source: string;
  who: string | null;
  note: string;
  href: string;
  url: string | null;
};

const RELATION: Record<string, { chip: string; tone: Tone }> = {
  new: { chip: "New", tone: "accent" },
  change: { chip: "Change", tone: "accent" },
  approval: { chip: "Approval", tone: "accent" },
  clarification: { chip: "Clarified", tone: "neutral" },
  context: { chip: "Context", tone: "neutral" },
};

/** The activity feed as one-line change rows. */
export function changeRows(entries: ActivityEntry[]): ChangeRow[] {
  return entries.map((e): ChangeRow => {
    if (e.kind === "jira") {
      return {
        key: `jira-${e.id}`,
        at: e.at.toISOString(),
        tone: "neutral",
        chip: "Jira",
        lead: e.change?.subject ? `${e.key} ${e.change.subject}` : e.key,
        parts: e.change ? changeParts(e.change) : null,
        text: `edited by ${e.author ?? "someone"}`,
        project: e.projectName,
        source: "Jira",
        who: e.author,
        note: e.text,
        href: e.projectId ? `/?c=${e.projectId}` : "/",
        url: e.url,
      };
    }
    const rel = RELATION[e.relation] ?? RELATION.context;
    return {
      key: `item-${e.id}`,
      at: e.at.toISOString(),
      tone: rel.tone,
      chip: rel.chip,
      lead: e.change?.subject ?? null,
      parts: e.change ? changeParts(e.change) : null,
      text: e.note || e.title,
      project: e.projectName,
      source: sourceOf(e.source).label,
      who: e.author,
      note: e.note,
      href: `/?c=${e.projectId}`,
      url: e.url,
    };
  });
}

/** A project's state in a few words, for its row on the home screen. */
export function projectLine(p: ProjectHealth): string {
  const overdue = p.risks.filter((r) => r.kind === "overdue").length;
  const conflicts = p.risks.filter((r) => r.kind === "drift").length;
  const parts = [
    conflicts ? `${conflicts} conflict${conflicts === 1 ? "" : "s"}` : null,
    p.needsYou ? `${p.needsYou} to approve` : null,
    overdue ? `${overdue} overdue` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : p.status === "attention" ? "Due today" : "On track";
}
