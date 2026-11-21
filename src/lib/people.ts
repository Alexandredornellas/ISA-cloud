// The people directory: who everyone is, and their duties: what they do or can help with, each
// for one project or company-wide. One person can hold many duties across many projects. The owner
// keeps it; ISA suggests facts from what it captures and the owner accepts them. Internal to ISA:
// nothing here contacts anyone.
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
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

export type DutyRow = typeof schema.personDuties.$inferSelect;
/** Placeholder duty for someone on a project whose part is not known yet. */
export const STAKEHOLDER = "Stakeholder";

/**
 * Give a person a duty, on a project or company-wide (projectId null). The same duty is not added
 * twice, and a real duty on a project replaces the "Stakeholder" placeholder there.
 */
export async function addDuty(input: { personId: string; projectId?: string | null; text?: string | null; eventId?: string | null; quote?: string | null }): Promise<DutyRow | null> {
  const projectId = input.projectId || null;
  const text = clean(input.text)?.slice(0, 200) ?? (projectId ? STAKEHOLDER : null);
  if (!text) return null;
  const same = await db
    .select()
    .from(schema.personDuties)
    .where(and(eq(schema.personDuties.personId, input.personId), projectId ? eq(schema.personDuties.projectId, projectId) : isNull(schema.personDuties.projectId)));
  const dup = same.find((d) => d.text.toLowerCase() === text.toLowerCase());
  if (dup) return dup;
  if (text === STAKEHOLDER && same.length) return same[0];
  const placeholders = same.filter((d) => d.text === STAKEHOLDER).map((d) => d.id);
  if (placeholders.length) await db.delete(schema.personDuties).where(inArray(schema.personDuties.id, placeholders));
  const [row] = await db
    .insert(schema.personDuties)
    .values({ personId: input.personId, projectId, text, eventId: input.eventId ?? null, quote: clean(input.quote)?.slice(0, 500) ?? null })
    .returning();
  return row;
}

export async function updateDuty(id: string, text: string) {
  const t = clean(text);
  if (!t) return removeDuty(id);
  await db.update(schema.personDuties).set({ text: t.slice(0, 200), updatedAt: new Date() }).where(eq(schema.personDuties.id, id));
}

export async function removeDuty(id: string) {
  await db.delete(schema.personDuties).where(eq(schema.personDuties.id, id));
}

/** Record the people a plan names as a project's stakeholders (called when a plan runs). */
export async function addProjectPeople(projectId: string, list: Person[]) {
  for (const p of list) {
    if (!p.name?.trim()) continue;
    const person = await upsertPerson({ name: p.name, email: p.email, slackUserId: p.slackUserId });
    await addDuty({ personId: person.id, projectId, text: p.role });
  }
}

export async function updatePerson(id: string, input: { name?: string; email?: string | null; title?: string | null; team?: string | null; notes?: string | null }) {
  const set: Partial<typeof schema.people.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined && input.name.trim()) set.name = input.name.trim().slice(0, 120);
  if (input.email !== undefined) set.email = clean(input.email);
  if (input.title !== undefined) set.title = clean(input.title);
  if (input.team !== undefined) set.team = clean(input.team);
  if (input.notes !== undefined) set.notes = clean(input.notes);
  await db.update(schema.people).set(set).where(eq(schema.people.id, id));
}

export async function removePerson(id: string) {
  await db.delete(schema.people).where(eq(schema.people.id, id));
}

/** Take someone off a project: removes their duties there. */
export async function unlinkFromProject(projectId: string, personId: string) {
  await db.delete(schema.personDuties).where(and(eq(schema.personDuties.projectId, projectId), eq(schema.personDuties.personId, personId)));
}

/** Split "a, b; c" typed by the owner into a list. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  for (const s of text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)) {
    if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s.slice(0, 200));
  }
  return out.slice(0, 30);
}

export type Duty = { id: string; text: string; projectId: string | null; projectName: string | null; quote: string | null };
export type DirectoryEntry = PersonRow & { duties: Duty[] };

async function dutiesOf(personIds: string[]): Promise<Map<string, Duty[]>> {
  const out = new Map<string, Duty[]>();
  if (!personIds.length) return out;
  const rows = await db
    .select({ d: schema.personDuties, projectName: schema.projects.name })
    .from(schema.personDuties)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.personDuties.projectId))
    .where(inArray(schema.personDuties.personId, personIds))
    .orderBy(sql`${schema.projects.name} asc nulls first`, asc(schema.personDuties.createdAt));
  for (const r of rows) {
    const list = out.get(r.d.personId) ?? [];
    list.push({ id: r.d.id, text: r.d.text, projectId: r.d.projectId, projectName: r.projectName, quote: r.d.quote });
    out.set(r.d.personId, list);
  }
  return out;
}

/** Everyone, or those matching a search over name, title, team, notes and any of their duties. */
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
            sql`exists (select 1 from ${schema.personDuties} d left join ${schema.projects} pr on pr.id = d.project_id where d.person_id = ${schema.people.id} and (d.text ilike ${like} or pr.name ilike ${like}))`,
          )
        : undefined,
    )
    .orderBy(asc(schema.people.name));
  const duties = await dutiesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, duties: duties.get(r.id) ?? [] }));
}

export type Stakeholder = DirectoryEntry & { here: Duty[] };

/** A project's stakeholders: everyone with a duty on it, with those duties first. */
export async function stakeholders(projectId: string): Promise<Stakeholder[]> {
  const ids = await db.selectDistinct({ id: schema.personDuties.personId }).from(schema.personDuties).where(eq(schema.personDuties.projectId, projectId));
  if (!ids.length) return [];
  const rows = await db.select().from(schema.people).where(inArray(schema.people.id, ids.map((i) => i.id))).orderBy(asc(schema.people.name));
  const duties = await dutiesOf(rows.map((r) => r.id));
  return rows.map((r) => {
    const all = duties.get(r.id) ?? [];
    return { ...r, duties: all, here: all.filter((d) => d.projectId === projectId) };
  });
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
    if (person && (await alreadyKnown(person, n.kind as SuggestionKind, n.text, projectId))) continue;
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

async function alreadyKnown(p: PersonRow, kind: SuggestionKind, text: string, projectId: string | null) {
  const t = text.trim().toLowerCase();
  if (kind === "role") return p.title?.toLowerCase() === t;
  const duties = (await dutiesOf([p.id])).get(p.id) ?? [];
  const scope = kind === "moves_project" ? projectId : null;
  return duties.some((d) => d.text.toLowerCase() === t && (kind === "can_help" || d.projectId === scope));
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
  else await addDuty({ personId: person.id, projectId: s.kind === "moves_project" ? s.projectId : null, text, eventId: s.eventId, quote: s.quote });
  await db.update(schema.personSuggestions).set({ status: "accepted", personId: person.id, text, updatedAt: new Date() }).where(eq(schema.personSuggestions.id, id));
}

export async function dismissSuggestion(id: string) {
  await db.update(schema.personSuggestions).set({ status: "dismissed", updatedAt: new Date() }).where(eq(schema.personSuggestions.id, id));
}

/** One person as a line of text for Claude, with each duty and where it applies. */
export function personLine(p: PersonRow & { duties?: Duty[]; here?: Duty[] }): string {
  const scope = (d: Duty) => (d.projectName ? `${d.text} [${d.projectName}]` : `${d.text} [company-wide]`);
  const bits = [
    p.here?.length ? `on this project: ${p.here.map((d) => d.text).join(", ")}` : null,
    p.title,
    p.team ? `team ${p.team}` : null,
    p.duties?.length ? `duties: ${p.duties.filter((d) => !p.here?.includes(d)).map(scope).join("; ")}` : null,
    p.email,
    p.slackUserId ? `Slack ${p.slackUserId}` : null,
    p.notes ? `notes: ${p.notes}` : null,
  ].filter((b) => b && b !== "duties: ");
  return bits.length ? `${p.name} (${bits.join("; ")})` : p.name;
}
