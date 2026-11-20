import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

// The owner's settings for how ISA drafts. Stored as one row of key-value pairs.
const KEY = "settings";

export type Settings = { storiesUnderEpic: boolean };

const DEFAULTS: Settings = { storiesUnderEpic: true };

export async function getSettings(): Promise<Settings> {
  const row = await db.query.workerState.findFirst({ where: eq(schema.workerState.key, KEY) });
  const v = row?.value ?? {};
  return { storiesUnderEpic: v.storiesUnderEpic ? v.storiesUnderEpic === "on" : DEFAULTS.storiesUnderEpic };
}

export async function saveSettings(s: Settings) {
  const value = { storiesUnderEpic: s.storiesUnderEpic ? "on" : "off" };
  await db
    .insert(schema.workerState)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.workerState.key, set: { value, updatedAt: new Date() } });
}

/** The drafting rules the settings add, for Claude to read. */
export function settingsText(s: Settings): string {
  return s.storiesUnderEpic
    ? "Owner's setting: every story, spike, bug and testing task goes under an epic. Set epicRef on each: an existing epic's Jira key when one fits (from the project or the related Jira tickets), otherwise create the epic in this same plan, before its stories, and use its requirementRef."
    : "Owner's setting: put a ticket under an epic (epicRef) only when an epic clearly fits; otherwise leave epicRef null.";
}
