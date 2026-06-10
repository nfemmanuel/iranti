ALTER TABLE "metric_counters" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_counters" DROP CONSTRAINT "metric_counters_pkey";--> statement-breakpoint
ALTER TABLE "metric_counters" ADD CONSTRAINT "metric_counters_tenant_id_name_pk" PRIMARY KEY("tenant_id","name");--> statement-breakpoint
ALTER TABLE "attend_log" ADD COLUMN "phase" text;