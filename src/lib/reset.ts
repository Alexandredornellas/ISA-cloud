// "Start blank": empty ISA's memory so the owner can test from scratch, keeping a full copy first.
// Kept as they are: connections (Google, Slack sign-ins and their cursors), settings and ticket
// formats. Everything else (projects, items, decisions, people, reminders, chat...) is cleared.
import { sql } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { db, schema } from "@/db";

const KEEP: string[] = [schema.connections, schema.workerState, schema.ticketFormats].map((t) => getTableName(t));

/** Tables in the public schema. */
async function publicTables(): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`);
  return [...rows].map((r) => r.name);
}

/**
 * Copy every table into a new schema named backup_<UTC time>, then empty everything except the
 * kept tables. Returns the backup's name and how many tables were cleared.
 */
export async function startBlank(now = new Date()): Promise<{ backup: string; cleared: number }> {
  const backup = `backup_${now.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15)}`;
  const tables = await publicTables();
  const clear = tables.filter((t) => !KEEP.includes(t));
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`create schema "${backup}"`));
    for (const t of tables) await tx.execute(sql.raw(`create table "${backup}"."${t}" as table public."${t}"`));
    if (clear.length) await tx.execute(sql.raw(`truncate ${clear.map((t) => `public."${t}"`).join(", ")}`));
  });
  return { backup, cleared: clear.length };
}

/** Backups made by startBlank, newest first. */
export async function blankBackups(): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`select schema_name as name from information_schema.schemata where schema_name like 'backup\_%' order by 1 desc`);
  return [...rows].map((r) => r.name);
}
