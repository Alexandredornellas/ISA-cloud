import { z } from "zod";

// Shared shapes: stored in the database as JSON, and used as Claude's structured-output schemas.
// Fields are nullable rather than optional so the model always states them explicitly.

export const PersonSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  slackUserId: z.string().nullable(),
  role: z.string().nullable(),
});
export type Person = z.infer<typeof PersonSchema>;

export const RequirementChangeSchema = z.object({
  // An existing requirement id, or a short temporary ref such as "R1" for a new one.
  ref: z.string(),
  op: z.enum(["create", "update", "drop"]),
  title: z.string(),
  description: z.string(),
  status: z.enum(["proposed", "approved", "changed"]),
  approvedBy: z.string().nullable(),
  reason: z.string().describe("Why this change, citing who said what and where"),
});
export type RequirementChange = z.infer<typeof RequirementChangeSchema>;

/** Details the owner confirms on a new ticket, when their settings ask for them. */
export const TicketDetailsSchema = z.object({
  sprint: z.string().nullable().describe("Name of the open sprint, or null"),
  storyPoints: z.number().nullable(),
  links: z.array(z.string()).describe("Jira keys of related existing tickets"),
  extra: z.array(z.object({ name: z.string(), value: z.string() })).describe("The owner's own fields, by name"),
});
export type TicketDetails = z.infer<typeof TicketDetailsSchema>;

const JiraCreateBase = z.object({
  type: z.literal("jira_create"),
  requirementRef: z.string(),
  summary: z.string(),
  description: z.string(),
  kind: z.enum(["story", "epic", "spike", "bug", "test"]).describe("Which ticket format to use"),
  epicRef: z
    .string()
    .nullable()
    .describe("The epic this ticket goes under: an existing epic's Jira key (e.g. SCRUM-1), or the requirementRef of an epic created earlier in this plan. Null for an epic, or when no epic fits."),
});

const JIRA_PROJECT_HELP =
  'Key of the Jira project to create it in (e.g. CHK): the existing project whose scope fits the work, or the key in newJiraProject when none fits. "" uses the project\'s default.';

/** A Jira project ISA suggests the owner creates, because none they have fits the work. ISA cannot create it. */
export const NewJiraProjectSchema = z.object({
  key: z.string().describe("Proposed key, 2 to 10 capital letters, not already used (e.g. NFS8)"),
  name: z.string().describe("Proposed project name"),
  template: z.enum(["scrum", "kanban"]).describe("scrum when the team will plan in sprints, kanban for a continuous flow"),
  reason: z.string().describe("One sentence: why none of the existing Jira projects fits"),
});
export type NewJiraProject = z.infer<typeof NewJiraProjectSchema>;
// Drafts always say where the ticket goes; plans saved before this have no jiraProject.
const DraftCreate = JiraCreateBase.extend({ jiraProject: z.string().describe(JIRA_PROJECT_HELP) });
const JiraCreate = JiraCreateBase.extend({ details: TicketDetailsSchema.nullable().optional(), jiraProject: z.string().optional() });

const JiraUpdate = z.object({
  type: z.literal("jira_update"),
  requirementRef: z.string(),
  // Null when the issue is created earlier in the same plan; resolved from requirementRef.
  issueKey: z.string().nullable(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
});

const JiraComment = z.object({
  type: z.literal("jira_comment"),
  requirementRef: z.string(),
  issueKey: z.string().nullable(),
  body: z.string(),
});

const JiraClose = z.object({
  type: z.literal("jira_close"),
  requirementRef: z.string(),
  issueKey: z.string().nullable(),
  reason: z.string().describe("Why the ticket is no longer needed, citing who decided it and where; posted as a comment"),
});

const SlackMessage = z.object({
  type: z.literal("slack_message"),
  // A channel id (C...) or a user id (U...) for a direct message.
  channel: z.string(),
  recipientLabel: z.string(),
  threadTs: z.string().nullable(),
  text: z.string(),
});

const Email = z.object({
  type: z.literal("email"),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  // Gmail thread id when replying in an existing thread.
  threadId: z.string().nullable(),
});

export const ActionSchema = z.union([JiraCreate, JiraUpdate, JiraComment, JiraClose, SlackMessage, Email]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];

export const PlanSchema = z.object({
  summary: z.string().describe("One or two sentences the user reads first"),
  // Only for new_project proposals.
  projectName: z.string().nullable(),
  // People involved: everyone for a new project, newly involved people for an update.
  people: z.array(PersonSchema),
  requirementChanges: z.array(RequirementChangeSchema),
  actions: z.array(ActionSchema),
  openQuestions: z.array(z.string()),
  /** Set when no existing Jira project fits; tickets with jiraProject = its key wait for the owner to create it. */
  newJiraProject: NewJiraProjectSchema.nullable().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

// What Claude fills in when drafting. Structured outputs compile the schema into a grammar with a
// size limit, and every nullable or optional field adds to it; so the draft schema uses empty
// values instead of null where it can, and has ticket details only when the owner asks for them.
const DraftTicketDetails = z.object({
  sprint: z.string().describe('Name of the open sprint, or "" for none'),
  storyPoints: z.number().describe("Estimate, or 0 for none"),
  links: z.array(z.string()).describe("Jira keys of related existing tickets"),
  extra: z.array(z.object({ name: z.string(), value: z.string() })).describe("The owner's own fields, by name"),
});

const draftSchemas = (withDetails: boolean) =>
  PlanSchema.extend({
    newJiraProject: NewJiraProjectSchema.describe(
      'Only when none of the Jira projects you can create tickets in fits this work (a different product, client or team): the project to suggest creating. Otherwise every field empty ("" and template "scrum").',
    ),
    actions: z.array(
      z.union([
        withDetails ? DraftCreate.extend({ details: DraftTicketDetails.describe("For epics, leave every field empty") }) : DraftCreate,
        JiraUpdate,
        JiraComment,
        JiraClose,
        SlackMessage,
        Email,
      ]),
    ),
  });

export const DraftSchema = draftSchemas(false);
export const DraftWithDetailsSchema = draftSchemas(true);

/** A draft as ISA stores it: empty ticket details become null. */
export function fromDraft(draft: z.infer<typeof DraftWithDetailsSchema> | z.infer<typeof DraftSchema>): Plan {
  const suggested = draft.newJiraProject;
  const key = suggested?.key.trim().toUpperCase() ?? "";
  return {
    ...draft,
    newJiraProject: /^[A-Z][A-Z0-9_]{1,9}$/.test(key) ? { ...suggested, key, name: suggested.name.trim() || key } : null,
    actions: draft.actions.map((a): Action => {
      if (a.type === "jira_create") a = { ...a, jiraProject: (a.jiraProject ?? "").trim().toUpperCase() };
      if (a.type !== "jira_create" || !("details" in a) || !a.details) return a as Action;
      const d = a.details as z.infer<typeof DraftTicketDetails>;
      if (a.kind === "epic") return { ...a, details: null };
      return {
        ...a,
        details: { sprint: d.sprint.trim() || null, storyPoints: d.storyPoints > 0 ? d.storyPoints : null, links: d.links, extra: d.extra },
      };
    }),
  };
}

export const SortMatchSchema = z.object({
  projectId: z.string(),
  relation: z.enum(["new", "clarification", "approval", "change", "context"]),
  confidence: z.enum(["high", "medium", "low"]),
  requirementIds: z.array(z.string()),
  note: z.string().describe("What in this item concerns the project, in one sentence"),
});

const CommitmentSchema = z.object({
  what: z.string(),
  /** Null when the owner owes it; otherwise who owes it to the owner. */
  owedBy: z.string().nullable().optional(),
  forWhom: z.string().nullable(),
  due: z.string().nullable(),
  dueText: z.string().nullable(),
  quote: z.string(),
  projectId: z.string().nullable(),
});

const PersonNoteSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  /** role: what they do. can_help: what they can help with or unblock. moves_project: how they move projectId forward. */
  kind: z.enum(["role", "can_help", "moves_project"]),
  text: z.string(),
  projectId: z.string().nullable(),
  quote: z.string(),
});

export const SortResultSchema = z.object({
  matches: z.array(SortMatchSchema),
  newProject: z
    .object({ name: z.string(), reason: z.string() })
    .nullable()
    .describe("Set when the item introduces work that fits no existing project"),
  ignore: z.boolean().describe("True when the item concerns no project and starts none"),
  searchTerms: z
    .array(z.string())
    .describe("2 or 3 short terms to search Jira for related tickets, including synonyms, e.g. MFA, two-factor, OTP"),
  commitments: z.array(CommitmentSchema).optional(),
  peopleNotes: z.array(PersonNoteSchema).optional(),
  reason: z.string(),
});
export type SortResult = z.infer<typeof SortResultSchema>;
export type Commitment = z.infer<typeof CommitmentSchema>;
export type PersonNote = z.infer<typeof PersonNoteSchema>;

/** What Claude fills in when sorting: empty strings instead of null, to keep the grammar small. */
export const SortDraftSchema = SortResultSchema.extend({
  commitments: z
    .array(
      z.object({
        what: z.string().describe("What must be sent or done, starting with a verb, e.g. 'Send the MFA mockups'"),
        owedBy: z.string().describe('"" when the owner must do it; otherwise the name of the person who promised it to the owner'),
        forWhom: z.string().describe('Who it is for, by name, or ""'),
        due: z.string().describe('Deadline as YYYY-MM-DD, resolved from the item\'s date, or "" when none was said'),
        dueText: z.string().describe('The deadline in the item\'s words, e.g. "by Friday", or ""'),
        quote: z.string().describe("The words it came from, short"),
        projectId: z.string().describe('The project it concerns, from the list, or ""'),
      }),
    )
    .describe("Things the owner promised or was asked to send or do, and things others promised the owner; empty when none"),
  peopleNotes: z
    .array(
      z.object({
        name: z.string().describe("The person's full name as the item gives it"),
        email: z.string().describe('Their email when the item shows it, or ""'),
        kind: z.enum(["role", "can_help", "moves_project"]),
        text: z.string().describe("The fact, short, e.g. 'Head of Payments', 'PCI compliance', 'Approves checkout scope'"),
        projectId: z.string().describe('For moves_project, the project from the list; otherwise the related project or ""'),
        quote: z.string().describe("The words it came from, short"),
      }),
    )
    .describe("Lasting facts about people: what they do, what they can help with, who moves a project forward; empty when none"),
});

export function fromSortDraft(d: z.infer<typeof SortDraftSchema>): SortResult {
  return {
    ...d,
    commitments: (d.commitments ?? []).map((c) => ({
      what: c.what,
      owedBy: c.owedBy?.trim() || null,
      forWhom: c.forWhom.trim() || null,
      due: c.due.trim() || null,
      dueText: c.dueText.trim() || null,
      quote: c.quote,
      projectId: c.projectId.trim() || null,
    })),
    peopleNotes: (d.peopleNotes ?? []).map((n) => ({
      name: n.name.trim(),
      email: n.email.trim() || null,
      kind: n.kind,
      text: n.text.trim(),
      projectId: n.projectId.trim() || null,
      quote: n.quote,
    })),
  };
}

const KIND_LABEL: Record<string, string> = {
  story: "story",
  epic: "epic",
  spike: "spike",
  bug: "bug",
  test: "testing task",
};

export function describeAction(a: Action): string {
  switch (a.type) {
    case "jira_create":
      return `Create ${KIND_LABEL[a.kind] ?? "ticket"}${a.jiraProject ? ` in ${a.jiraProject}` : ""}: ${a.summary}${a.epicRef && a.kind !== "epic" ? ` (under epic ${a.epicRef})` : ""}`;
    case "jira_update":
      return `Update ${a.issueKey ?? a.requirementRef}${a.summary ? `: ${a.summary}` : ""}`;
    case "jira_comment":
      return `Comment on ${a.issueKey ?? a.requirementRef}`;
    case "jira_close":
      return `Close ${a.issueKey ?? a.requirementRef}: ${a.reason}`;
    case "slack_message":
      return `Slack ${a.recipientLabel}`;
    case "email":
      return `Email ${a.to.join(", ")}`;
  }
}
