// Diagrams from what ISA knows: a user flow, a sequence between systems, or a state machine, drawn
// as Mermaid from a project's requirements and decisions. Internal: saved for the owner, never sent.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { ROLE } from "@/lib/brain/prompts";
import { projectBlock } from "@/lib/brain/context";
import type { StructuredLLM } from "@/lib/brain/llm";
import { decisionTrail, trailText } from "@/lib/trail";

export const DIAGRAM_KINDS = {
  flow: { label: "User flow", mermaid: "flowchart TD" },
  sequence: { label: "Sequence between systems", mermaid: "sequenceDiagram" },
  state: { label: "States of an item", mermaid: "stateDiagram-v2" },
} as const;
export type DiagramKind = keyof typeof DIAGRAM_KINDS;

const DiagramSchema = z.object({
  title: z.string().describe("Short title, e.g. 'Guest checkout with Pix'"),
  mermaid: z.string().describe("Mermaid source only, no code fences"),
  notes: z.string().describe("One to three short lines: what the diagram assumes, and what the records leave open. '' when nothing"),
});

const SYSTEM = `${ROLE}

Task: draw one diagram in Mermaid from the project's records, for the owner to use in a refinement session or a document.

Rules:
- Use only steps, actors, systems and rules the records support. Where a step is undecided, show it as a decision with a question mark and list it in notes, instead of guessing.
- Keep it readable: at most about 15 nodes. Short labels, sentence case.
- Valid Mermaid that renders: start with the given diagram type. In flowcharts use simple ids (A, B, C) and put labels in quotes, e.g. A["Buyer opens checkout"]; decisions as B{"Pays by?"}. No HTML, no styles, no click handlers, no parentheses or quotes inside labels.`;

/** Draw a diagram and save it. Throws when the model's Mermaid is empty. */
export async function drawDiagram(llm: StructuredLLM, input: { projectId: string; requirementId?: string | null; kind: DiagramKind; ask?: string | null }) {
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId) });
  if (!project) throw new Error("Project not found");
  const trail = input.requirementId ? await decisionTrail(input.requirementId) : null;
  const out = await llm({
    system: SYSTEM,
    context: [`The project:\n${await projectBlock(project.id)}`, trail ? `The requirement to draw, with its history:\n${trailText(trail)}` : ""].filter(Boolean).join("\n\n"),
    input: `Diagram type: ${DIAGRAM_KINDS[input.kind].label}, Mermaid "${DIAGRAM_KINDS[input.kind].mermaid}".${trail ? ` Draw the requirement "${trail.requirement.title}".` : " Draw the project's main flow."}${input.ask?.trim() ? `\nThe owner asks: ${input.ask.trim()}` : ""}`,
    schema: DiagramSchema,
    effort: "medium",
  });
  const mermaid = cleanMermaid(out.mermaid);
  if (!mermaid) throw new Error("ISA could not draw this one. Try adding what the diagram should show.");
  const [row] = await db
    .insert(schema.diagrams)
    .values({ projectId: project.id, requirementId: trail?.requirement.id ?? null, kind: input.kind, title: out.title.trim().slice(0, 120) || project.name, mermaid, notes: out.notes.trim() })
    .returning();
  return row;
}

/** Strip code fences and anything that could run in the browser. */
export function cleanMermaid(src: string): string {
  return src
    .replace(/^```(?:mermaid)?\s*/i, "")
    .replace(/```\s*$/, "")
    .split("\n")
    .filter((l) => !/^\s*(click|%%\{|style|classDef|linkStyle)\b/i.test(l))
    .join("\n")
    .replace(/<[^>]*>/g, "")
    .trim();
}
