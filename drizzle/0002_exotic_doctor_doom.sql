ALTER TABLE "facts" DROP CONSTRAINT "facts_entity_key_uniq";--> statement-breakpoint
DROP INDEX "fact_archive_entity_key_idx";--> statement-breakpoint
ALTER TABLE "fact_archive" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "fact_archive_entity_key_idx" ON "fact_archive" USING btree ("tenant_id","entity_type","entity_id","key","archived_at");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_tenant_entity_key_uniq" UNIQUE("tenant_id","entity_type","entity_id","key");