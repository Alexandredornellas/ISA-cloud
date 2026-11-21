// The people directory: who everyone is, what they can help with, and who moves each project
// forward. The owner keeps it; ISA suggests facts from what it captures and the owner accepts them.
// Internal to ISA: nothing here contacts anyone.
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Person, PersonNote } from "@/lib/plan";

export type PersonRow = typeof schema.people.$inferSelect;
export type SuggestionRow = typeof schema.personSuggestions.$inferSelect;
export const SUGGESTION_KINDS = ["role", "can_help", "moves_project"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

const clean = (s: string | null | undefined) => s?.trim() || null;

/** Find a person by email, Slack id, then name (case-insensitive). */
export async function findPerson(p: { name?: string | null; email?: string | null; slackUserId?: string | null }): Promise<PersonRow | null> {
  const email = clean(p.email)?.toLowerCase();
  const slack = clean(p.slackUserId);
  const name = clean(p.name);
  if (email) {
    const [row] = await db.select().from(schema.people).where(sql`lower(${schema.people.email}) = ${email}`).limit(1);
    if (row) return row;
  }
  if (slack) {
    const [row] = await db.select().from(schema.people).where(eq(schema.people.slackUserId, slack)).limit(1);
    if (row) return row;
  }
  if (name) {
    const [row] = await db.select().from(schema.people).where(sql`lower(${schema.people.name}) = ${name.toLowerCase()}`).limit(1);
    if (row) return row;
  }
  return null;
}

/** Find or create a person; given values fill gaps but never overwrite what the owner wrote. */
export async function upsertPerson(p: { name: string; email?: string | null; slackUserId?: string | null; title?: string | null; team?: string | null }): Promise<PersonRow> {
  const name = p.name.trim();
  if (!name) throw new Error("A person needs a name");
  const found = await findPerson(p);
  if (found) {
    const patch = {
      email: found.email ?? clean(p.email),
      slackUserId: found.slackUserId ?? clean(p.slackUserId),
      title: found.title ?? clean(p.title),
      team: found.team ?? clean(p.team),
    };
    if (Object.entries(patch).some(([k, v]) => v !== found[k as keyof typeof patch])) {
      const [row] = await db.update(schema.people).set({ ...patch, updatedAt: new Date() }).where(eq(schema.people.id, found.id)).returning();
      return row;
    }
    return found;
  }
  const [row] = await db
    .insert(schema.people)
    .values({ name: name.slice(0, 120), email: clean(p.email), slackUserId: clean(p.slackUserId), title: clean(p.title), team: clean(p.team) })
    .returning();
  return row;
}

/** Link a person to a project; a given role replaces an empty one only unless `replace`. */
export async function linkToProject(projectId: string, personId: string, role?: string | null, replace = false) {
  const [existing] = await db
    .select()
    .from(schema.projectPeople)
    .where(and(eq(schema.projectPeople.projectId, projectId), eq(schema.projectPeople.personId, personId)));
  if (existing) {
    const next = replace ? clean(role) ?? existing.role : existing.role ?? clean(role);
    if (next !== existing.role) {
      await db.update(schema.projectPeople).set({ role: next, updatedAt: new Date() }).where(eq(schema.projectPeople.id, existing.id));
    }
    return;
  }
  await db.insert(schema.projectPeople).values({ projectId, personId, role: clean(role) }).onConflictDoNothing();
}

/** Record the people a plan names as a project's stakeholders (called when a plan runs). */
export async function addProjectPeople(projectId: string, list: Person[]) {
  for (const p of list) {
    if (!p.name?.trim()) continue;
    const person = await upsertPerson({ name: p.name, email: p.email, slackUserId: p.slackUserId });
    await linkToProject(projectId, person.id, p.role);
  }
}

export async function updatePerson(id: string, input: { name?: string; email?: string | null; title?: string | null; team?: string | null; canHelpWith?: string[]; notes?: string | null }) {
  const set: Partial<typeof schema.people.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined && input.name.trim()) set.name = input.name.trim().slice(0, 120);
  if (input.email !== undefined) set.email = clean(input.email);
  if (input.title !== undefined) set.title = clean(input.title);
  if (input.team !== undefined) set.team = clean(input.team);
  if (input.notes !== undefined) set.notes = clean(input.notes);
  if (input.canHelpWith !== undefined) set.canHelpWith = dedupe(input.canHelpWith);
  await db.update(schema.people).set(set).where(eq(schema.people.id, id));
}

export async function removePerson(id: string) {
  await db.delete(schema.people).where(eq(schema.people.id, id));
}

export async function unlinkFromProject(projectId: string, personId: string) {
  await db.delete(schema.projectPeople).where(and(eq(schema.projectPeople.projectId, projectId), eq(schema.projectPeople.personId, personId)));
}

function dedupe(list: string[]): string[] {
  const out: string[] = [];
  for (const s of list.map((x) => x.trim()).filter(Boolean)) {
    if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s.slice(0, 120));
  }
  return out.slice(0, 30);
}

/** Split "a, b; c" typed by the owner into a list. */
export function splitList(text: string): string[] {
  return dedupe(text.split(/[,;\n]/));
}

export type DirectoryEntry = PersonRow & { projects: { id: string; name: string; role: string | null }[] };

/** Everyone, or those matching a search over name, title, team, notes and what they help with. */
export async function directory(query?: string | null): Promise<DirectoryEntry[]> {
  const q = clean(query);
  const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
  const rows = await db
    .select()
    .from(schema.people)
    .where(
      like
        ? or(
            ilike(schema.people.name, like),
            ilike(schema.people.title, like),
            ilike(schema.people.team, like),
            ilike(schema.people.notes, like),
            sql`${schema.people.canHelpWith}::text ilike ${like}`,
          )
        : undefined,
    )
    .orderBy(asc(schema.people.name));
  if (!rows.length) return [];
  const links = await db
    .select({ personId: schema.projectPeople.personId, id: schema.projects.id, name: schema.projects.name, role: schema.projectPeople.role })
    .from(schema.projectPeople)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectPeople.projectId))
    .where(inArray(schema.projectPeople.personId, rows.map((r) => r.id)));
  return rows.map((r) => ({ ...r, projects: links.filter((l) => l.personId === r.id).map(({ id, name, role }) => ({ id, name, role })) }));
}

export type Stakeholder = PersonRow & { role: string | null };

/** A project's stakeholders: who moves it forward, and how. */
export async function stakeholders(projectId: string): Promise<Stakeholder[]> {
  const rows = await db
    .select({ person: schema.people, role: schema.projectPeople.role })
    .from(schema.projectPeople)
    .innerJoin(schema.people, eq(schema.people.id, schema.projectPeople.personId))
    .where(eq(schema.projectPeople.projectId, projectId))
    .orderBy(asc(schema.people.name));
  return rows.map((r) => ({ ...r.person, role: r.role }));
}

/** Save what an item says about people, as suggestions for the owner. Skips what is already known. */
export async function savePersonNotes(eventId: string, notes: PersonNote[], projectIds: Set<string>): Promise<number> {
  const list = notes.filter((n) => n.name.trim() && n.text.trim() && SUGGESTION_KINDS.includes(n.kind as SuggestionKind));
  if (!list.length) return 0;
  const pending = await db.select({ name: schema.personSuggestions.name, text: schema.personSuggestions.text }).from(schema.personSuggestions).where(eq(schema.personSuggestions.eventId, eventId));
  const seen = new Set(pending.map((s) => `${s.name.toLowerCase()}|${s.text.toLowerCase()}`));
  let added = 0;
  for (const n of list) {
    const key = `${n.name.trim().toLowerCase()}|${n.text.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projectId = n.projectId && projectIds.has(n.projectId) ? n.projectId : null;
    if (n.kind === "moves_project" && !projectId) continue;
    const person = await findPerson({ name: n.name, email: n.email });
    if (person && alreadyKnown(person, n.kind as SuggestionKind, n.text)) continue;
    await db.insert(schema.personSuggestions).values({
      eventId,
      projectId,
      personId: person?.id ?? null,
      name: person?.name ?? n.name.trim().slice(0, 120),
      email: clean(n.email),
      kind: n.kind,
      text: n.text.trim().slice(0, 200),
      quote: clean(n.quote)?.slice(0, 500) ?? null,
    });
    added++;
  }
  return added;
}

function alreadyKnown(p: PersonRow, kind: SuggestionKind, text: string) {
  const t = text.trim().toLowerCase();
  if (kind === "role") return p.title?.toLowerCase() === t;
  if (kind === "can_help") return p.canHelpWith.some((c) => c.toLowerCase() === t);
  return false;
}

export type SuggestionView = SuggestionRow & { projectName: string | null; source: { source: string; title: string; url: string | null; at: Date } | null };

/** Suggestions waiting for the owner (a project's, or all), newest first. */
export async function pendingSuggestions(projectId?: string | null): Promise<SuggestionView[]> {
  const rows = await db
    .select({ s: schema.personSuggestions, projectName: schema.projects.name, source: schema.events.source, title: schema.events.title, url: schema.events.url, at: schema.events.occurredAt })
    .from(schema.personSuggestions)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.personSuggestions.projectId))
    .leftJoin(schema.events, eq(schema.events.id, schema.personSuggestions.eventId))
    .where(and(eq(schema.personSuggestions.status, "pending"), projectId ? eq(schema.personSuggestions.projectId, projectId) : undefined))
    .orderBy(desc(schema.personSuggestions.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...r.s, projectName: r.projectName, source: r.source && r.title && r.at ? { source: r.source, title: r.title, url: r.url, at: r.at } : null }));
}

export async function suggestionCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.personSuggestions).where(eq(schema.personSuggestions.status, "pending"));
  return r?.n ?? 0;
}

/** Accept a suggestion, optionally with the owner's edited text, and file it on the person. */
export async function acceptSuggestion(id: string, editedText?: string | null) {
  const [s] = await db.select().from(schema.personSuggestions).where(eq(schema.personSuggestions.id, id));
  if (!s || s.status !== "pending") return;
  const text = clean(editedText) ?? s.text;
  const person = s.personId
    ? (await db.query.people.findFirst({ where: eq(schema.people.id, s.personId) })) ?? (await upsertPerson({ name: s.name, email: s.email }))
    : await upsertPerson({ name: s.name, email: s.email });
  if (s.kind === "role") await updatePerson(person.id, { title: text });
  else if (s.kind === "can_help") await updatePerson(person.id, { canHelpWith: [...person.canHelpWith, text] });
  if (s.projectId) await linkToProject(s.projectId, person.id, s.kind === "moves_project" ? text : null, s.kind === "moves_project");
  await db.update(schema.personSuggestions).set({ status: "accepted", personId: person.id, text, updatedAt: new Date() }).where(eq(schema.personSuggestions.id, id));
}

export async function dismissSuggestion(id: string) {
  await db.update(schema.personSuggestions).set({ status: "dismissed", updatedAt: new Date() }).where(eq(schema.personSuggestions.id, id));
}

/** One person as a line of text for Claude. */
export function personLine(p: PersonRow & { role?: string | null; projects?: { name: string; role: string | null }[] }): string {
  const bits = [
    p.role ? `on this project: ${p.role}` : null,
    p.title,
    p.team ? `team ${p.team}` : null,
    p.canHelpWith.length ? `can help with ${p.canHelpWith.join(", ")}` : null,
    p.projects?.length ? `projects: ${p.projects.map((x) => (x.role ? `${x.name} (${x.role})` : x.name)).join(", ")}` : null,
    p.email,
    p.slackUserId ? `Slack ${p.slackUserId}` : null,
    p.notes ? `notes: ${p.notes}` : null,
  ].filter(Boolean);
  return bits.length ? `${p.name} (${bits.join("; ")})` : p.name;
}
