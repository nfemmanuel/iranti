/**
 * PostgreSQL-backed Staff event emitter for Iranti.
 *
 * Persists Staff events to the `staff_events` table via Prisma raw SQL.
 * Handles the table-not-yet-created race by attempting DDL bootstrap on the
 * first `relation does not exist` error, then retrying the insert. Bootstrap
 * is attempted at most once per emitter instance to prevent retry storms.
 *
 * All writes are fire-and-forget: emit() returns immediately and the insert
 * runs in a tracked Promise. Call flush() before process shutdown to drain
 * any in-flight writes.
 *
 * Key export:
 *   - DbStaffEventEmitter  — concrete IStaffEventEmitter backed by staff_events
 */

import { Prisma } from '../generated/prisma/client';
import { getDb } from '../library/client';
import { buildStaffEvent, IStaffEventEmitter, StaffEvent } from './staffEventEmitter';
import { ensureStaffEventsTable } from './staffEventsTable';

function isMissingStaffEventsTable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /relation ["']?staff_events["']? does not exist/i.test(message);
}

function summarizeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class DbStaffEventEmitter implements IStaffEventEmitter {
    private warnedTableMissing = false;
    private pending = new Set<Promise<void>>();
    private bootstrapAttempted = false;

    emit(input: Parameters<IStaffEventEmitter['emit']>[0]): void {
        const event = buildStaffEvent(input);

        const task = this.insertEvent(event)
            .catch((error) => {
                if (isMissingStaffEventsTable(error)) {
                    if (!this.warnedTableMissing) {
                        this.warnedTableMissing = true;
                        console.warn('[staff-events] staff_events table is missing; event emission is disabled until the table exists.');
                    }
                    return;
                }

                console.error(`[staff-events] failed to persist event ${event.eventId}: ${summarizeError(error)}`);
            })
            .finally(() => {
                this.pending.delete(task);
            });
        this.pending.add(task);
    }

    async flush(): Promise<void> {
        const pending = Array.from(this.pending);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
    }

    private async insertEvent(event: StaffEvent): Promise<void> {
        try {
            await this.executeInsert(event);
        } catch (error) {
            if (!isMissingStaffEventsTable(error) || this.bootstrapAttempted) {
                throw error;
            }

            this.bootstrapAttempted = true;
            await ensureStaffEventsTable();
            await this.executeInsert(event);
        }
    }

    private async executeInsert(event: StaffEvent): Promise<void> {
        await getDb().$executeRaw(
            Prisma.sql`
                INSERT INTO staff_events (
                    event_id,
                    timestamp,
                    staff_component,
                    action_type,
                    agent_id,
                    source,
                    entity_type,
                    entity_id,
                    key,
                    reason,
                    level,
                    metadata
                ) VALUES (
                    ${event.eventId}::uuid,
                    ${event.timestamp}::timestamptz,
                    ${event.staffComponent},
                    ${event.actionType},
                    ${event.agentId ?? null},
                    ${event.source ?? null},
                    ${event.entityType ?? null},
                    ${event.entityId ?? null},
                    ${event.key ?? null},
                    ${event.reason ?? null},
                    ${event.level},
                    ${event.metadata ? JSON.stringify(event.metadata) : null}::jsonb
                )
            `
        );
    }
}
