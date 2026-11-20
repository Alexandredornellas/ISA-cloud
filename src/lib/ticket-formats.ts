import { db, schema } from "@/db";

export const TICKET_KINDS = ["story", "epic", "spike", "bug", "test"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export type TicketFormat = { kind: TicketKind; name: string; jiraIssueType: string; label: string | null; template: string };

export const KIND_NAME: Record<TicketKind, string> = {
  story: "User story",
  epic: "Epic",
  spike: "Spike",
  bug: "Bug",
  test: "Testing task",
};

const WHEN: Record<TicketKind, string> = {
  story: "a user-facing feature or change that one team can deliver",
  epic: "a large body of work that groups several stories, usually one per new project or major feature",
  spike: "research or a technical investigation needed before the team can estimate or decide",
  bug: "something that should work and does not",
  test: "testing work for a requirement, such as a test plan or acceptance testing",
};

/** The formats ISA starts with. The owner can change each one on the Settings page. */
export const DEFAULT_FORMATS: Record<TicketKind, TicketFormat> = {
  story: {
    kind: "story",
    name: "User story",
    jiraIssueType: "Story",
    label: null,
    template: `As a <type of user>, I want <goal> so that <benefit>.

Context:
<why this matters, who asked for it, and where it was decided>

Acceptance criteria:
- Given <situation>, when <action>, then <result>
- ...

Out of scope:
- <what this story does not cover, if anything was said>`,
  },
  epic: {
    kind: "epic",
    name: "Epic",
    jiraIssueType: "Epic",
    label: null,
    template: `Goal:
<the outcome this epic delivers, in one or two sentences>

Scope:
- <capability>
- ...

Success measures:
- <how we know it worked>

Stakeholders:
- <name, role>`,
  },
  spike: {
    kind: "spike",
    name: "Spike",
    jiraIssueType: "Task",
    label: "spike",
    template: `Question to answer:
<what the team needs to learn>

Why now:
<the decision or work this unblocks>

Approach:
- <how to investigate>

Timebox: <for example 2 days>

Done when:
- A written recommendation is shared with <who>`,
  },
  bug: {
    kind: "bug",
    name: "Bug",
    jiraIssueType: "Bug",
    label: null,
    template: `Problem:
<what is wrong, in one sentence>

Steps to reproduce:
1. ...

Expected result:
<what should happen>

Actual result:
<what happens instead>

Environment:
<browser, device, version, if known>

Severity: <low, medium, high or critical>, because <reason>`,
  },
  test: {
    kind: "test",
    name: "Testing task",
    jiraIssueType: "Task",
    label: "testing",
    template: `What is tested:
<the requirement or feature>

Preconditions:
- ...

Test steps:
1. ...

Expected results:
- ...

Test data:
- <accounts, inputs or files needed>`,
  },
};

/** Every format, with the owner's saved changes over the defaults. */
export async function ticketFormats(): Promise<TicketFormat[]> {
  const saved = await db.select().from(schema.ticketFormats);
  return TICKET_KINDS.map((kind) => {
    const row = saved.find((r) => r.kind === kind);
    return row
      ? { kind, name: row.name || DEFAULT_FORMATS[kind].name, jiraIssueType: row.jiraIssueType, label: row.label, template: row.template }
      : DEFAULT_FORMATS[kind];
  });
}

/** Save the owner's version of one format. */
export async function saveTicketFormat(f: TicketFormat) {
  const values = { ...f, updatedAt: new Date() };
  await db.insert(schema.ticketFormats).values(values).onConflictDoUpdate({ target: schema.ticketFormats.kind, set: values });
}

/** The formats as instructions for Claude. */
export function formatsText(formats: TicketFormat[]): string {
  return [
    "Ticket formats. Pick the kind that fits and write the description exactly in that kind's format, replacing every <...> with real content from the items. Leave out a section only when the items say nothing about it and it is optional; never invent facts to fill one.",
    ...formats.map((f) => `<format kind="${f.kind}" name="${f.name}">\nUse for ${WHEN[f.kind]}.\n${f.template}\n</format>`),
  ].join("\n\n");
}
