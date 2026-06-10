CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"key" text NOT NULL,
	"object_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"description_text" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "media_objects_entity_idx" ON "media_objects" USING btree ("tenant_id","entity_type","entity_id");