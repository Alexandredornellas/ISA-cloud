import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import type { Person, Plan, SortResult } from "@/lib/plan";

export const eventSource = pgEnum("event_source", [
  "zoom",
  "meet",
  "teams",
  "gmail",
  "slack",
  "manual",
  "jira",
]);

export const eventStatus = pgEnum("event_status", [
  "new", // waiting to be sorted
  "sorted", // filed under one or more projects
  "unsure", // waiting for the user to say which project
  "ignored", // not about any project
  "failed", // sorting failed; can be retried
]);

export const requirementStatus = pgEnum("requirement_status", [
  "proposed",
  "approved",
  "changed",
  "done",
  "dropped",
]);

export const proposalKind = pgEnum("proposal_kind", [
  "new_project", // ISA thinks an event starts a new project
  "update", // changes to an existing project
  "clarify", // "Is this about project X?"
]);

export const proposalStatus = pgEnum("proposal_status", [
  "pending",
  "approved", // approved, actions running
  "executed", // all actions succeeded
  "failed", // at least one action failed
  "dismissed",
]);

export const actionStatus = pgEnum("action_status", ["pending", "done", "failed", "skipped"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  jiraProjectKey: text("jira_project_key"),
  slackChannelId: text("slack_channel_id"),
  people: jsonb("people").$type<Person[]>().notNull().default([]),
  ...timestamps,
});

export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: requirementStatus("status").notNull().default("proposed"),
    approvedBy: text("approved_by"),
    jiraIssueKey: text("jira_issue_key"),
    // The ticket's status in Jira as of the last sync, e.g. "Em andamento".
    jiraStatus: text("jira_status"),
    ...timestamps,
  },
  (t) => [index("requirements_project_idx").on(t.projectId)],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: eventSource("source").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    participants: jsonb("participants").$type<Person[]>().notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    url: text("url"),
    // Where to reply on the same channel, e.g. Slack channel + thread, or Gmail thread id.
    replyTo: jsonb("reply_to").$type<Record<string, string>>(),
    status: eventStatus("status").notNull().default("new"),
    sortResult: jsonb("sort_result").$type<SortResult>(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("events_source_external_idx").on(t.source, t.externalId),
    index("events_status_idx").on(t.status),
  ],
);

// Which projects an event was filed under. One event can touch several projects.
export const eventProjects = pgTable(
  "event_projects",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(), // new | clarification | approval | change | context
    note: text("note").notNull().default(""),
  },
  (t) => [uniqueIndex("event_projects_pk").on(t.eventId, t.projectId)],
);

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: proposalKind("kind").notNull(),
    status: proposalStatus("status").notNull().default("pending"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    plan: jsonb("plan").$type<Plan>().notNull(),
    eventIds: uuid("event_ids").array().notNull().default([]),
    // Temporary requirement refs in the plan ("R1") mapped to real requirement ids after approval.
    refs: jsonb("refs").$type<Record<string, string>>().notNull().default({}),
    error: text("error"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("proposals_status_idx").on(t.status)],
);

// Log of every outside action ISA took, so the project timeline can show it.
export const actions = pgTable("actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposalId: uuid("proposal_id")
    .notNull()
    .references(() => proposals.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  type: text("type").notNull(),
  // Order within the proposal: a comment on a new ticket must run after the ticket is created.
  position: integer("position").notNull().default(0),
  status: actionStatus("status").notNull().default("pending"),
  payload: jsonb("payload").notNull(),
  result: jsonb("result"),
  error: text("error"),
  ...timestamps,
});

export const projectRules = pgTable("project_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  ...timestamps,
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant
  // Full Anthropic content blocks, kept so the conversation can be replayed unchanged.
  content: jsonb("content").notNull(),
  ...timestamps,
});

// OAuth tokens for Gmail, Google Calendar and Slack. Encrypted at rest by the database host.
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // google | slack
    account: text("account").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    // Provider-specific cursors, e.g. Gmail historyId.
    state: jsonb("state").$type<Record<string, string>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex("connections_provider_idx").on(t.provider)],
);

export const botStatus = pgEnum("bot_status", [
  "scheduled", // created, waiting to join
  "in_call", // joined, recording
  "processing", // call ended, waiting for the transcript
  "done", // transcript stored as an event
  "failed",
]);

// Meeting-bot sessions (Recall.ai). The worker polls active ones and turns each finished
// transcript into one event.
export const meetingBots = pgTable(
  "meeting_bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recallBotId: text("recall_bot_id").notNull(),
    meetingUrl: text("meeting_url").notNull(),
    title: text("title").notNull(),
    platform: eventSource("platform").notNull(),
    joinAt: timestamp("join_at", { withTimezone: true }),
    status: botStatus("status").notNull().default("scheduled"),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    // Calendar event this bot was scheduled for, so it is not scheduled twice.
    calendarEventId: text("calendar_event_id"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("meeting_bots_recall_idx").on(t.recallBotId), index("meeting_bots_status_idx").on(t.status)],
);

// Small key-value store for the worker's cursors, e.g. the last Slack message seen per channel.
export const workerState = pgTable("worker_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, string>>().notNull().default({}),
  ...timestamps,
});

// The owner's ticket format for each kind of ticket (story, epic, spike, bug, test).
// Kinds without a row use the defaults in src/lib/ticket-formats.ts.
export const ticketFormats = pgTable("ticket_formats", {
  kind: text("kind").primaryKey(),
  // The owner's name for this kind, e.g. "História de usuário". Empty uses the default name.
  name: text("name").notNull().default(""),
  jiraIssueType: text("jira_issue_type").notNull(),
  label: text("label"),
  template: text("template").notNull(),
  ...timestamps,
});

// ISA's record of each Jira ticket it manages: the last known state, so changes can be compared.
export const jiraTickets = pgTable("jira_tickets", {
  key: text("key").primaryKey(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  issueType: text("issue_type"),
  summary: text("summary").notNull().default(""),
  description: text("description").notNull().default(""),
  status: text("status"),
  assignee: text("assignee"),
  sprint: text("sprint"),
  epic: text("epic"),
  labels: jsonb("labels").$type<string[]>().notNull().default([]),
  jiraUpdatedAt: timestamp("jira_updated_at", { withTimezone: true }),
  // Jira change-history entries up to this id are already recorded.
  historySeenUpTo: text("history_seen_up_to"),
  // When ISA itself wrote to this ticket, so its own edits are not mistaken for someone else's.
  isaWrites: jsonb("isa_writes").$type<string[]>().notNull().default([]),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
});

// Every change to a managed ticket, from Jira's change history: who changed what, and when.
export const ticketChanges = pgTable(
  "ticket_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    historyId: text("history_id").notNull(),
    field: text("field").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    author: text("author"),
    authorAccountId: text("author_account_id"),
    byIsa: text("by_isa").notNull().default("no"), // "yes" when ISA made it
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    // The event ISA filed to review this change, if it needed review.
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ticket_changes_entry_idx").on(t.historyId, t.field),
    index("ticket_changes_key_idx").on(t.key),
  ],
);

// Things the owner promised to send or do, picked up from meetings, email and Slack or added by
// hand. Internal to ISA: a reminder never contacts anyone.
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    // What to send or do, e.g. "Send the MFA mockups".
    text: text("text").notNull(),
    // "mine": the owner owes it to person. "theirs": person owes it to the owner (a waiting-on).
    direction: text("direction").notNull().default("mine"),
    // Who it is for (mine) or who owes it (theirs), e.g. "Ana Costa".
    person: text("person"),
    due: timestamp("due", { withTimezone: true }),
    // The deadline as said, e.g. "by Friday".
    dueText: text("due_text"),
    // The words it came from, so the owner can trust it.
    quote: text("quote"),
    status: text("status").notNull().default("open"), // open | done | dismissed
    doneAt: timestamp("done_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("reminders_status_idx").on(t.status)],
);

// Company-wide directory: who people are, what they do and what they can help with. The owner
// keeps it by hand; ISA suggests additions from what it captures, and the owner accepts them.
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email"),
    slackUserId: text("slack_user_id"),
    // What they do, e.g. "Head of Payments".
    title: text("title"),
    team: text("team"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("people_email_idx").on(t.email)],
);

// What each person does or can help with: many per person, each for one project or company-wide
// (projectId null). A person is a project's stakeholder when they have a duty on it.
export const personDuties = pgTable(
  "person_duties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // e.g. "Approves scope changes", "PCI compliance", "Stakeholder" when nothing more is known.
    text: text("text").notNull(),
    // The item it was learned from, when ISA suggested it.
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    quote: text("quote"),
    ...timestamps,
  },
  (t) => [index("person_duties_person_idx").on(t.personId), index("person_duties_project_idx").on(t.projectId)],
);

// Facts about people that ISA noticed in meetings, email or Slack, waiting for the owner.
export const personSuggestions = pgTable(
  "person_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    email: text("email"),
    // role: what they do. can_help: what they can help with. moves_project: how they move projectId forward.
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    quote: text("quote"),
    status: text("status").notNull().default("pending"), // pending | accepted | dismissed
    ...timestamps,
  },
  (t) => [index("person_suggestions_status_idx").on(t.status)],
);
