import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

// The owner's settings for how ISA drafts. Stored as one row of key-value pairs.
const KEY = "settings";

/**
 * "Always ask for ...": for each checked field, ISA suggests a value on every ticket she drafts
 * and the card asks the owner to confirm or change it before the ticket is created.
 */
export type Settings = {
  askEpic: boolean;
  askSprint: boolean;
  askStoryPoints: boolean;
  askLinks: boolean;
  /** The owner's own fields, e.g. "Component" or "Due date". */
  askCustom: string[];
  /** How the owner appears in meetings, email and Slack, so ISA knows which promises are theirs. */
  ownerName: string;
};

const DEFAULTS: Settings = { askEpic: true, askSprint: false, askStoryPoints: false, askLinks: false, askCustom: [], ownerName: "" };

const flag = (v: string | undefined, fallback: boolean) => (v ? v === "on" : fallback);

export async function getSettings(): Promise<Settings> {
  const row = await db.query.workerState.findFirst({ where: eq(schema.workerState.key, KEY) });
  const v = row?.value ?? {};
  let custom: string[] = [];
  try {
    custom = v.askCustom ? (JSON.parse(v.askCustom) as string[]).filter((s) => typeof s === "string" && s.trim()) : [];
  } catch {
    custom = [];
  }
  return {
    // "storiesUnderEpic" is the older name of the epic setting.
    askEpic: flag(v.askEpic ?? v.storiesUnderEpic, DEFAULTS.askEpic),
    askSprint: flag(v.askSprint, DEFAULTS.askSprint),
    askStoryPoints: flag(v.askStoryPoints, DEFAULTS.askStoryPoints),
    askLinks: flag(v.askLinks, DEFAULTS.askLinks),
    askCustom: custom,
    ownerName: v.ownerName ?? "",
  };
}

export async function saveSettings(s: Settings) {
  const on = (b: boolean) => (b ? "on" : "off");
  const value = {
    askEpic: on(s.askEpic),
    askSprint: on(s.askSprint),
    askStoryPoints: on(s.askStoryPoints),
    askLinks: on(s.askLinks),
    askCustom: JSON.stringify([...new Set(s.askCustom.map((c) => c.trim()).filter(Boolean))].slice(0, 10)),
    ownerName: s.ownerName.trim().slice(0, 120),
  };
  await db
    .insert(schema.workerState)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.workerState.key, set: { value, updatedAt: new Date() } });
}

/** True when the owner wants to confirm any detail on new tickets. */
export function asksDetails(s: Settings): boolean {
  return s.askSprint || s.askStoryPoints || s.askLinks || s.askCustom.length > 0;
}

/** The drafting rules the settings add, for Claude to read. */
export function settingsText(s: Settings): string {
  const lines = [
    s.askEpic
      ? "Owner's setting: every story, spike, bug and testing task goes under an epic. Set epicRef on each: an existing epic's Jira key when one fits (from the project or the related Jira tickets), otherwise create the epic in this same plan, before its stories, and use its requirementRef. The owner confirms the epic on the card."
      : "Owner's setting: put a ticket under an epic (epicRef) only when an epic clearly fits; otherwise leave epicRef null.",
  ];
  if (asksDetails(s)) {
    const want = [
      s.askSprint ? "sprint: the name of the open sprint the work best fits (from the open sprints listed), or null when none fits" : null,
      s.askStoryPoints ? "storyPoints: your estimate on the Fibonacci scale (1, 2, 3, 5, 8, 13), from the scope the items describe" : null,
      s.askLinks ? "links: Jira keys of existing tickets this one relates to, depends on or duplicates (from the project or the related tickets); empty when none" : null,
      s.askCustom.length
        ? `extra: one entry for each of these fields, in this order: ${s.askCustom.map((c) => `"${c}"`).join(", ")}. Suggest a value from the items, or "" when they say nothing about it`
        : null,
    ].filter(Boolean);
    lines.push(
      `Owner's setting: the owner confirms these details on every ticket you create except epics. Fill details on each such jira_create with your suggestion; never invent facts, and say in openQuestions when you could not suggest something:\n${want.map((w) => `- ${w}`).join("\n")}`,
    );
  }
  return lines.join("\n");
}
