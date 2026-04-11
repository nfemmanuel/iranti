/**
 * Bootstrap helper for the staff_events PostgreSQL table.
 *
 * The staff_events table is an append-only audit log for all Iranti staff
 * component actions (Librarian decisions, Attendant scans, conflict resolutions,
 * etc.). It is created on first use via `ensureStaffEventsTable()`, which runs
 * all DDL statements idempotently and coalesces concurrent calls into a single
 * in-flight promise so the table is never bootstrapped twice in the same process.
 *
 * Key exports:
 *   - ensureStaffEventsTable()          — idempotent table + index creation
 *   - resetStaffEventsTableBootstrap()  — reset ensured flag (test use only)
 */

import { getDb } from '../library/client';

const STAFF_EVENTS_BOOTSTRAP_STATEMENTS = [
    `
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
        )
    `,
    'CREATE INDEX IF NOT EXISTS "staff_events_timestamp_idx" ON "staff_events"("timestamp" DESC)',
    'CREATE INDEX IF NOT EXISTS "staff_events_agent_id_timestamp_idx" ON "staff_events"("agent_id", "timestamp" DESC)',
    'CREATE INDEX IF NOT EXISTS "staff_events_source_timestamp_idx" ON "staff_events"("source", "timestamp" DESC)',
    'CREATE INDEX IF NOT EXISTS "staff_events_level_timestamp_idx" ON "staff_events"("level", "timestamp" DESC)',
    'CREATE INDEX IF NOT EXISTS "staff_events_entity_lookup_idx" ON "staff_events"("entity_type", "entity_id", "key", "timestamp" DESC)',
    'CREATE INDEX IF NOT EXISTS "staff_events_session_id_idx" ON "staff_events" ((metadata->>\'sessionId\'))',
    'CREATE INDEX IF NOT EXISTS "staff_events_host_idx" ON "staff_events" ((metadata->>\'host\'))',
];

let ensured = false;
let pendingEnsure: Promise<void> | null = null;

export function resetStaffEventsTableBootstrap(): void {
    ensured = false;
    pendingEnsure = null;
}

export async function ensureStaffEventsTable(): Promise<void> {
    if (ensured) return;
    if (pendingEnsure) return pendingEnsure;

    pendingEnsure = (async () => {
        const db = getDb() as {
            $executeRawUnsafe?: (query: string) => Promise<unknown>;
        };

        if (typeof db.$executeRawUnsafe !== 'function') {
            throw new Error('Database client does not support $executeRawUnsafe for staff_events bootstrap.');
        }

        for (const statement of STAFF_EVENTS_BOOTSTRAP_STATEMENTS) {
            await db.$executeRawUnsafe(statement);
        }
        ensured = true;
    })().finally(() => {
        pendingEnsure = null;
    });

    return pendingEnsure;
}
