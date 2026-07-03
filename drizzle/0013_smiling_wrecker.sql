CREATE TABLE "project_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_a" text NOT NULL,
	"project_b" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "project_links_pair_uniq" UNIQUE("project_a","project_b")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_excluded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_tenant_entity_key_uniq";--> statement-breakpoint
ALTER TABLE "knowledge_edges" DROP CONSTRAINT "knowledge_edges_canonical_pair_uniq";--> statement-breakpoint
ALTER TABLE "extraction_cache" DROP CONSTRAINT "extraction_cache_pk";--> statement-breakpoint
ALTER TABLE "extraction_cache" ADD CONSTRAINT "extraction_cache_tenant_id_input_hash_regime_signature_pk" PRIMARY KEY("tenant_id","input_hash","regime_signature");--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "project" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD COLUMN "project" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "project" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "project" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "project_links_a_idx" ON "project_links" USING btree ("project_a","is_active");--> statement-breakpoint
CREATE INDEX "project_links_b_idx" ON "project_links" USING btree ("project_b","is_active");--> statement-breakpoint
CREATE INDEX "media_objects_project_entity_idx" ON "media_objects" USING btree ("project","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "rules_project_entity_active_idx" ON "rules" USING btree ("project","entity_type","entity_id","is_active");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_tenant_project_entity_key_uniq" UNIQUE("tenant_id","project","entity_type","entity_id","key");--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_canonical_pair_uniq" UNIQUE("tenant_id","project","source_type","source_id","target_type","target_id","relation");