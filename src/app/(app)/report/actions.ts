"use server";

import type { Audience, Report } from "@/lib/brain/report";
import { log } from "@/lib/log";

export type ReportState = { report: Report | null; error: string | null; audience: Audience; projectId: string };

export async function draftStatusReport(_prev: ReportState, form: FormData): Promise<ReportState> {
  const { AUDIENCES, draftReport } = await import("@/lib/brain/report");
  const { claudeStructured } = await import("@/lib/brain/llm");
  const raw = String(form.get("audience") ?? "executive");
  const audience = (raw in AUDIENCES ? raw : "executive") as Audience;
  const projectId = String(form.get("projectId") ?? "");
  try {
    const report = await draftReport(claudeStructured, audience, projectId || null);
    return { report, error: null, audience, projectId };
  } catch (err) {
    log.error("status report failed", err);
    return { report: null, error: err instanceof Error ? err.message : "ISA could not write the report.", audience, projectId };
  }
}
