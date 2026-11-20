import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { ReportBuilder } from "@/components/ReportBuilder";

export const dynamic = "force-dynamic";

export default async function ReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { c } = await searchParams;
  const projects = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt));
  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Status report</h1>
      <p className="mt-1 text-sm text-muted">ISA writes it from what happened in your meetings, email, Slack and Jira this week, in the right tone for who will read it.</p>
      <div className="mt-5">
        <ReportBuilder projects={projects} initialProject={typeof c === "string" && projects.some((p) => p.id === c) ? c : ""} />
      </div>
    </div>
  );
}
