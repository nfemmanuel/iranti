CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"key" text NOT NULL,
	"existing_fact_id" uuid,
	"existing_value" text NOT NULL,
	"new_value" text NOT NULL,
	"existing_source" text NOT NULL,
	"new_source" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_reliability" (
	"source" text PRIMARY KEY NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"score" real DEFAULT 0.5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
