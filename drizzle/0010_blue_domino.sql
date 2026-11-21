CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"slack_user_id" text,
	"title" text,
	"team" text,
	"can_help_with" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"project_id" uuid,
	"person_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"quote" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_suggestions" ADD CONSTRAINT "person_suggestions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_suggestions" ADD CONSTRAINT "person_suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_suggestions" ADD CONSTRAINT "person_suggestions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_people" ADD CONSTRAINT "project_people_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_people" ADD CONSTRAINT "project_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_email_idx" ON "people" USING btree ("email");--> statement-breakpoint
CREATE INDEX "person_suggestions_status_idx" ON "person_suggestions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_people_unique" ON "project_people" USING btree ("project_id","person_id");--> statement-breakpoint
INSERT INTO "people" ("name", "email", "slack_user_id")
SELECT DISTINCT ON (lower(coalesce(p->>'email', p->>'name'))) p->>'name', nullif(p->>'email', ''), nullif(p->>'slackUserId', '')
FROM "projects", jsonb_array_elements("projects"."people") AS p
WHERE coalesce(p->>'name', '') <> '';--> statement-breakpoint
INSERT INTO "project_people" ("project_id", "person_id", "role")
SELECT DISTINCT ON (pr."id", pe."id") pr."id", pe."id", nullif(p->>'role', '')
FROM "projects" pr, jsonb_array_elements(pr."people") AS p, "people" pe
WHERE lower(coalesce(pe."email", pe."name")) = lower(coalesce(nullif(p->>'email', ''), p->>'name'))
ON CONFLICT DO NOTHING;
