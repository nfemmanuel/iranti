CREATE TABLE IF NOT EXISTS "staff_events" (
    "event_id" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staff_component" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "key" TEXT,
    "reason" TEXT,
    "level" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT "staff_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX IF NOT EXISTS "staff_events_timestamp_idx" ON "staff_events"("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "staff_events_agent_id_timestamp_idx" ON "staff_events"("agent_id", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "staff_events_source_timestamp_idx" ON "staff_events"("source", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "staff_events_level_timestamp_idx" ON "staff_events"("level", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "staff_events_entity_lookup_idx" ON "staff_events"("entity_type", "entity_id", "key", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "staff_events_session_id_idx" ON "staff_events" ((metadata->>'sessionId'));
CREATE INDEX IF NOT EXISTS "staff_events_host_idx" ON "staff_events" ((metadata->>'host'));
