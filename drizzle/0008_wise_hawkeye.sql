ALTER TABLE "attend_log" ADD COLUMN "corrections_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_count" integer DEFAULT 0 NOT NULL;