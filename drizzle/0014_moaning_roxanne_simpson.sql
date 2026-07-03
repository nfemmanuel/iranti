CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"project" text DEFAULT 'default' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"alias" text NOT NULL,
	"raw_alias" text NOT NULL,
	"fact_key" text NOT NULL,
	"source" text NOT NULL,
	"confidence" real DEFAULT 0.85 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_aliases_tenant_project_entity_alias_uniq" UNIQUE("tenant_id","project","entity_type","entity_id","alias")
);
--> statement-breakpoint
CREATE INDEX "entity_aliases_lookup_idx" ON "entity_aliases" USING btree ("tenant_id","project","entity_type","entity_id","is_active");