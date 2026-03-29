import { Prisma } from '../generated/prisma/client';
import { getDb } from '../library/client';
import { buildStaffEvent, IStaffEventEmitter, StaffEvent } from './staffEventEmitter';

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
