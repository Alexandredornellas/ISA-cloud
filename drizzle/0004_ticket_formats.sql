CREATE TABLE "ticket_formats" (
	"kind" text PRIMARY KEY NOT NULL,
	"jira_issue_type" text NOT NULL,
	"label" text,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
