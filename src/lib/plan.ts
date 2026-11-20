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

const JiraCreate = z.object({
  type: z.literal("jira_create"),
  requirementRef: z.string(),
  summary: z.string(),
  description: z.string(),
  kind: z.enum(["story", "epic", "spike", "bug", "test"]).describe("Which ticket format to use"),
});

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

export const ActionSchema = z.union([JiraCreate, JiraUpdate, JiraComment, SlackMessage, Email]);
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
});
export type Plan = z.infer<typeof PlanSchema>;

export const SortMatchSchema = z.object({
  projectId: z.string(),
  relation: z.enum(["new", "clarification", "approval", "change", "context"]),
  confidence: z.enum(["high", "medium", "low"]),
  requirementIds: z.array(z.string()),
  note: z.string().describe("What in this item concerns the project, in one sentence"),
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
  reason: z.string(),
});
export type SortResult = z.infer<typeof SortResultSchema>;

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
      return `Create ${KIND_LABEL[a.kind] ?? "ticket"}: ${a.summary}`;
    case "jira_update":
      return `Update ${a.issueKey ?? a.requirementRef}${a.summary ? `: ${a.summary}` : ""}`;
    case "jira_comment":
      return `Comment on ${a.issueKey ?? a.requirementRef}`;
    case "slack_message":
      return `Slack ${a.recipientLabel}`;
    case "email":
      return `Email ${a.to.join(", ")}`;
  }
}
