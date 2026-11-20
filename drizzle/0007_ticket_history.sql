ALTER TYPE "public"."event_source" ADD VALUE 'jira';--> statement-breakpoint
CREATE TABLE "jira_tickets" (
	"key" text PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"issue_type" text,
	"summary" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text,
	"assignee" text,
	"sprint" text,
	"epic" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jira_updated_at" timestamp with time zone,
	"history_seen_up_to" text,
	"isa_writes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"project_id" uuid,
	"history_id" text NOT NULL,
	"field" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"author" text,
	"author_account_id" text,
	"by_isa" text DEFAULT 'no' NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_tickets" ADD CONSTRAINT "jira_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_changes" ADD CONSTRAINT "ticket_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_changes" ADD CONSTRAINT "ticket_changes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_changes_entry_idx" ON "ticket_changes" USING btree ("history_id","field");--> statement-breakpoint
CREATE INDEX "ticket_changes_key_idx" ON "ticket_changes" USING btree ("key");