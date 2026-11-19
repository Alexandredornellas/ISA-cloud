CREATE TYPE "public"."bot_status" AS ENUM('scheduled', 'in_call', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "meeting_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recall_bot_id" text NOT NULL,
	"meeting_url" text NOT NULL,
	"title" text NOT NULL,
	"platform" "event_source" NOT NULL,
	"join_at" timestamp with time zone,
	"status" "bot_status" DEFAULT 'scheduled' NOT NULL,
	"event_id" uuid,
	"calendar_event_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_bots" ADD CONSTRAINT "meeting_bots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_bots_recall_idx" ON "meeting_bots" USING btree ("recall_bot_id");--> statement-breakpoint
CREATE INDEX "meeting_bots_status_idx" ON "meeting_bots" USING btree ("status");