ALTER TYPE "public"."event_source" ADD VALUE 'confluence';--> statement-breakpoint
CREATE TABLE "diagrams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"requirement_id" uuid,
	"title" text NOT NULL,
	"kind" text DEFAULT 'flow' NOT NULL,
	"mermaid" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagrams_project_idx" ON "diagrams" USING btree ("project_id");