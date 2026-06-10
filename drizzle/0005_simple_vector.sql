CREATE TABLE "attend_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"session_id" uuid,
	"agent_id" uuid,
	"surface" text,
	"fact_count" integer DEFAULT 0 NOT NULL,
	"rule_count" integer DEFAULT 0 NOT NULL,
	"already_present" integer DEFAULT 0 NOT NULL,
	"injected_chars" integer DEFAULT 0 NOT NULL,
	"injected_tokens_est" integer DEFAULT 0 NOT NULL,
	"suppressed_tokens_est" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_reliability" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_reliability" DROP CONSTRAINT "source_reliability_pkey";--> statement-breakpoint
ALTER TABLE "source_reliability" ADD CONSTRAINT "source_reliability_tenant_id_source_pk" PRIMARY KEY("tenant_id","source");--> statement-breakpoint
CREATE INDEX "attend_log_tenant_created_idx" ON "attend_log" USING btree ("tenant_id","created_at");
