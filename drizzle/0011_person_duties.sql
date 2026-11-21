CREATE TABLE "person_duties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"project_id" uuid,
	"text" text NOT NULL,
	"event_id" uuid,
	"quote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_duties" ADD CONSTRAINT "person_duties_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_duties" ADD CONSTRAINT "person_duties_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_duties" ADD CONSTRAINT "person_duties_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_duties_person_idx" ON "person_duties" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_duties_project_idx" ON "person_duties" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "person_duties" ("person_id", "project_id", "text")
SELECT "person_id", "project_id", coalesce(nullif(trim("role"), ''), 'Stakeholder') FROM "project_people";--> statement-breakpoint
INSERT INTO "person_duties" ("person_id", "project_id", "text")
SELECT p."id", NULL, h.value FROM "people" p, jsonb_array_elements_text(p."can_help_with") AS h(value)
WHERE trim(h.value) <> '';
