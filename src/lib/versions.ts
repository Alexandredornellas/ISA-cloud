// Requirement versions, kept as a slowly changing dimension (type 2): every change closes the open
// version and opens a new one, with the full text, the reason, who changed it and the sources.
// Nothing here is loaded into Claude's everyday context; it answers history questions.
import { and, asc, desc, eq, inArray, isNull, lte, or, gt } from "drizzle-orm";
import { db, schema } from "@/db";

type RequirementRow = typeof schema.requirements.$inferSelect;
export type RequirementVersion = typeof schema.requirementVersions.$inferSelect;
export type VersionSource = { reason?: string | null; changedBy?: string; proposalId?: string | null; eventIds?: string[]; at?: Date };

const same = (v: Pick<RequirementVersion, "title" | "description" | "status" | "approvedBy">, r: Pick<RequirementRow, "title" | "description" | "status" | "approvedBy">) =>
  v.title === r.title && v.description === r.description && v.status === r.status && (v.approvedBy ?? null) === (r.approvedBy ?? null);

/**
 * Record the requirement's new state as a new version, unless it matches the open one. Call it
 * after every change to a requirement's title, description, status or approver, with the row as
 * it was before the change (null for a new requirement).
 */
export async function recordVersion(
  req: RequirementRow,
  source: VersionSource = {},
  before: RequirementRow | null = null,
): Promise<RequirementVersion | null> {
  await ensureVersions(req.id, before);
  const [open] = await db
    .select()
    .from(schema.requirementVersions)
    .where(eq(schema.requirementVersions.requirementId, req.id))
    .orderBy(desc(schema.requirementVersions.version))
    .limit(1);
  if (open && same(open, req)) return null;
  const at = source.at ?? new Date();
  if (open) await db.update(schema.requirementVersions).set({ validTo: at }).where(eq(schema.requirementVersions.id, open.id));
  const [row] = await db
    .insert(schema.requirementVersions)
    .values({
      requirementId: req.id,
      projectId: req.projectId,
      version: (open?.version ?? 0) + 1,
      title: req.title,
      description: req.description,
      status: req.status,
      approvedBy: req.approvedBy,
      reason: source.reason || null,
      changedBy: source.changedBy ?? "ISA",
      proposalId: source.proposalId ?? null,
      eventIds: source.eventIds ?? [],
      validFrom: at,
    })
    .returning();
  return row;
}

const current = (id: string) => db.query.requirements.findFirst({ where: eq(schema.requirements.id, id) });

/** All versions of a requirement, oldest first. Rebuilt from its change records the first time. */
export async function versionsOf(requirementId: string): Promise<RequirementVersion[]> {
  await ensureVersions(requirementId, (await current(requirementId)) ?? null);
  return db
    .select()
    .from(schema.requirementVersions)
    .where(eq(schema.requirementVersions.requirementId, requirementId))
    .orderBy(asc(schema.requirementVersions.version));
}

/** The version that was in force at a moment, or null if the requirement did not exist yet. */
export async function versionAt(requirementId: string, at: Date): Promise<RequirementVersion | null> {
  await ensureVersions(requirementId, (await current(requirementId)) ?? null);
  const [row] = await db
    .select()
    .from(schema.requirementVersions)
    .where(
      and(
        eq(schema.requirementVersions.requirementId, requirementId),
        lte(schema.requirementVersions.validFrom, at),
        or(isNull(schema.requirementVersions.validTo), gt(schema.requirementVersions.validTo, at)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Requirements saved before versions existed have none. Rebuild them once from the change records
 * (filed items and approved proposals) that touched the requirement. `base` is the requirement's
 * state before the change being recorded now (or its current state when only reading): it is
 * added last when it differs, because a hand edit or Jira changed it outside those records.
 * A brand-new requirement passes no base, so the caller's version becomes version 1.
 */
async function ensureVersions(requirementId: string, base: RequirementRow | null): Promise<void> {
  const [any] = await db
    .select({ id: schema.requirementVersions.id })
    .from(schema.requirementVersions)
    .where(eq(schema.requirementVersions.requirementId, requirementId))
    .limit(1);
  if (any || !base) return;

  const proposals = await db.query.proposals.findMany({
    where: and(eq(schema.proposals.projectId, base.projectId), inArray(schema.proposals.status, ["pending", "approved", "executed", "failed"])),
    orderBy: asc(schema.proposals.createdAt),
  });
  type Draft = Omit<typeof schema.requirementVersions.$inferInsert, "version">;
  const fromRow = (r: RequirementRow, reason: string, changedBy: string, at: Date): Draft => ({
    requirementId,
    projectId: r.projectId,
    title: r.title,
    description: r.description,
    status: r.status,
    approvedBy: r.approvedBy,
    reason,
    changedBy,
    validFrom: at,
  });
  const drafts: Draft[] = [];
  for (const p of proposals) {
    // Only changes that were actually saved to memory count.
    const saved = p.memoryAppliedAt || ["executed", "failed"].includes(p.status);
    if (!saved) continue;
    for (const c of p.plan.requirementChanges) {
      if ((p.refs[c.ref] ?? c.ref) !== requirementId) continue;
      drafts.push({
        requirementId,
        projectId: base.projectId,
        title: c.title,
        description: c.description,
        status: c.op === "drop" ? "dropped" : c.status,
        approvedBy: c.approvedBy ?? drafts.at(-1)?.approvedBy ?? null,
        reason: c.reason || null,
        changedBy: "ISA",
        proposalId: p.id,
        eventIds: p.eventIds,
        validFrom: p.memoryAppliedAt ?? p.decidedAt ?? p.createdAt,
      });
    }
  }
  if (!drafts.length) drafts.push(fromRow(base, "Recorded before ISA kept versions", "ISA", base.createdAt));
  else if (!same(drafts.at(-1) as RequirementVersion, base)) {
    const last = drafts.at(-1)!.validFrom as Date;
    drafts.push(fromRow(base, "Changed outside a filed item (by hand or from Jira)", "unknown", base.updatedAt > last ? base.updatedAt : last));
  }
  const rows = drafts.map((d, i) => ({ ...d, version: i + 1, validTo: drafts[i + 1]?.validFrom ?? null }));
  await db.insert(schema.requirementVersions).values(rows).onConflictDoNothing();
}
