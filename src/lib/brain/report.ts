// Status reports drafted for one audience: executives, the delivery team, or a client. Built from
// ISA's records only. The owner reviews and copies it; nothing is sent from here.
import { z } from "zod";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { ROLE } from "./prompts";
import { projectBlock } from "./context";
import type { StructuredLLM } from "./llm";
import { portfolio, portfolioText } from "@/lib/portfolio";
import { activity } from "@/lib/activity";

export const AUDIENCES = {
  executive: {
    label: "Executives",
    brief: "Senior leadership with two minutes. Lead with overall status per project (on track, at risk), the decisions or help needed from them, and dates at risk. No ticket-level detail, no jargon.",
  },
  team: {
    label: "Delivery team",
    brief: "The engineers, designers and QA doing the work. What changed in the requirements and why, which Jira tickets were created or changed (with keys), open questions they should know about, and who is waiting on whom.",
  },
  client: {
    label: "Client or stakeholders",
    brief: "The people who asked for the work. Friendly and confident. What was delivered or decided since last time, what comes next, and what you need from them (with dates). No internal risks phrased in a way that alarms; never mention internal tools or ISA.",
  },
} as const;

export type Audience = keyof typeof AUDIENCES;

const ReportSchema = z.object({
  subject: z.string().describe("A short subject line, e.g. 'Weekly status: Checkout redesign, week of Nov 16'"),
  body: z.string().describe("The report in Markdown, ready to paste into an email or Slack"),
});

export type Report = z.infer<typeof ReportSchema>;

const SYSTEM = `${ROLE}

Task: write a status report for one audience from ISA's records.

Rules:
- Use only facts in the records. Never invent progress, dates, owners or numbers. When something is unknown, leave it out or say it is being confirmed.
- Name people and dates as the records give them. Give Jira keys only to the delivery team.
- Be brief and scannable: short sections, bullets, the most important thing first.
- Write it in the owner's voice, ready to send. End with what you need from the readers, if anything.`;

export async function draftReport(llm: StructuredLLM, audience: Audience, projectId: string | null): Promise<Report> {
  const { projects, reminders } = await portfolio();
  const scope = projectId ? projects.filter((p) => p.id === projectId) : projects;
  if (!scope.length) throw new Error("There are no projects to report on yet.");
  const recent = await activity(projectId, 25);
  const weekAgo = Date.now() - 7 * 86400000;
  const changes = recent
    .filter((e) => e.at.getTime() > weekAgo)
    .map((e) =>
      e.kind === "jira"
        ? `- ${e.at.toISOString().slice(0, 10)} Jira ${e.key}: ${e.text}`
        : `- ${e.at.toISOString().slice(0, 10)} ${e.source} "${e.title}" (${e.projectName}): ${e.note}${e.outcomes[0] ? ` Outcome: ${e.outcomes[0].status}, ${e.outcomes[0].steps.map((s) => `${s.state} ${s.text}`).join("; ")}` : ""}`,
    )
    .join("\n");
  const details = projectId ? await projectBlock(projectId) : "";
  const project = projectId ? await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }) : null;
  return llm({
    system: SYSTEM,
    context: [
      `Portfolio${project ? ` (this report covers only ${project.name})` : " (this report covers all projects)"}:\n${portfolioText(scope, reminders)}`,
      details ? `The project in detail:\n${details}` : "",
      `What happened in the last 7 days:\n${changes || "(nothing recorded)"}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    input: `Audience: ${AUDIENCES[audience].label}. ${AUDIENCES[audience].brief}\nToday is ${new Date().toISOString().slice(0, 10)}.`,
    schema: ReportSchema,
    effort: "medium",
  });
}
