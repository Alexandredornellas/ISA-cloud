import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { DIAGRAM_KINDS } from "@/lib/brain/diagram";
import { MermaidView } from "@/components/MermaidView";
import { SubmitButton } from "@/components/SubmitButton";
import { timeAgo } from "@/lib/sources";
import { deleteDiagram, newDiagram } from "./actions";

export const dynamic = "force-dynamic";

const input = "rounded-lg border border-line bg-bg px-3 py-2 text-sm";

export default async function DiagramsPage({ searchParams }: { searchParams: Promise<{ project?: string; requirement?: string; error?: string }> }) {
  const { project, requirement, error } = await searchParams;
  const [projects, reqs, diagrams] = await Promise.all([
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
    db.select({ id: schema.requirements.id, projectId: schema.requirements.projectId, title: schema.requirements.title }).from(schema.requirements).orderBy(asc(schema.requirements.createdAt)),
    db
      .select({ d: schema.diagrams, projectName: schema.projects.name, requirementTitle: schema.requirements.title })
      .from(schema.diagrams)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.diagrams.projectId))
      .leftJoin(schema.requirements, eq(schema.requirements.id, schema.diagrams.requirementId))
      .orderBy(desc(schema.diagrams.createdAt))
      .limit(30),
  ]);
  const preset = project ? `${project}${requirement ? `:${requirement}` : ""}` : "";

  return (
    <div className="mx-auto max-w-4xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Diagrams</h1>
      <p className="mt-1 text-sm text-muted">
        ISA draws from what was actually agreed: a project&apos;s requirements and the decisions behind them. Anything still open shows as a question, so you know what to ask next.
      </p>

      <form action={newDiagram} className="mt-5 grid gap-2 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_200px]">
        <select name="target" required defaultValue={preset} aria-label="What to draw" className={input}>
          <option value="" disabled>
            What should ISA draw?
          </option>
          {projects.map((p) => (
            <optgroup key={p.id} label={p.name}>
              <option value={p.id}>{p.name}: the main flow</option>
              {reqs
                .filter((r) => r.projectId === p.id)
                .map((r) => (
                  <option key={r.id} value={`${p.id}:${r.id}`}>
                    {r.title}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <select name="kind" defaultValue="flow" aria-label="Diagram type" className={input}>
          {Object.entries(DIAGRAM_KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <input name="ask" placeholder="Anything to focus on? e.g. include the payment provider and failure paths" aria-label="What to focus on" className={`${input} sm:col-span-2`} />
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          {error ? <p className="text-sm text-danger" role="alert">{error}</p> : <span className="text-xs text-muted">Takes about 20 seconds.</span>}
          <SubmitButton className="bg-accent text-white">Draw it</SubmitButton>
        </div>
      </form>

      {diagrams.length ? (
        <ul className="mt-8 space-y-6">
          {diagrams.map(({ d, projectName, requirementTitle }) => (
            <li key={d.id} id={`d-${d.id}`} className="scroll-mt-6 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="font-semibold">{d.title}</h2>
                  <p className="text-xs text-muted">
                    {DIAGRAM_KINDS[d.kind as keyof typeof DIAGRAM_KINDS]?.label ?? d.kind} · {projectName ?? "No project"}
                    {requirementTitle && d.requirementId ? (
                      <>
                        {" · from "}
                        <Link href={`/decisions/${d.requirementId}`} className="hover:text-ink hover:underline">
                          {requirementTitle}
                        </Link>
                      </>
                    ) : null}{" "}
                    · {timeAgo(d.createdAt)}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <details className="relative">
                    <summary className="cursor-pointer list-none rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-hover">Mermaid</summary>
                    <pre className="absolute right-0 z-10 mt-1 max-h-80 w-80 overflow-auto rounded-lg border border-line bg-surface p-3 text-xs shadow-lg sm:w-[28rem]">{d.mermaid}</pre>
                  </details>
                  <form action={deleteDiagram}>
                    <input type="hidden" name="id" value={d.id} />
                    <button className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-danger">Delete</button>
                  </form>
                </div>
              </div>
              <div className="mt-4">
                <MermaidView source={d.mermaid} title={d.title} />
              </div>
              {d.notes ? <p className="mt-3 whitespace-pre-line rounded-lg bg-bg p-3 text-sm text-muted">{d.notes}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-8 text-sm text-muted">No diagrams yet. Pick a project or a requirement above.</p>
      )}
    </div>
  );
}
