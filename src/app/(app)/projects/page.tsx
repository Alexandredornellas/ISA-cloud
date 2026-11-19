import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const rows = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      summary: schema.projects.summary,
      updatedAt: schema.projects.updatedAt,
      requirementCount: sql<number>`(select count(*)::int from requirements r where r.project_id = ${schema.projects.id} and r.status <> 'dropped')`,
    })
    .from(schema.projects)
    .orderBy(desc(schema.projects.updatedAt));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Projects</h1>
      <p className="mt-1 text-sm text-muted">
        ISA creates a project when it hears about new work, after you approve it.
      </p>
      <ul className="mt-5 space-y-3">
        {rows.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${p.id}`}
              className="block rounded-xl border border-line bg-surface p-4 hover:border-accent"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-semibold">{p.name}</span>
                <span className="shrink-0 text-xs text-muted">{p.requirementCount} requirements</span>
              </div>
              {p.summary ? <p className="mt-1 line-clamp-2 text-sm text-muted">{p.summary}</p> : null}
            </Link>
          </li>
        ))}
        {rows.length === 0 ? <li className="text-sm text-muted">No projects yet.</li> : null}
      </ul>
    </div>
  );
}
