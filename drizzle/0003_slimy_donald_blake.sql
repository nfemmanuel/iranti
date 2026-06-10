CREATE TABLE "knowledge_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"relation" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"co_access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reinforced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_edges_canonical_pair_uniq" UNIQUE("tenant_id","source_type","source_id","target_type","target_id","relation")
);
--> statement-breakpoint
CREATE INDEX "knowledge_edges_source_idx" ON "knowledge_edges" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_edges_target_idx" ON "knowledge_edges" USING btree ("target_type","target_id");