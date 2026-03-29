import { Prisma } from '../generated/prisma/client';
import { getDb } from '../library/client';
import type { EventLevel, StaffComponent } from './staffEventEmitter';

export interface SessionLedgerQuery {
    agentId?: string;
    sessionId?: string;
    actionType?: string;
    source?: string;
    level?: EventLevel;
    since?: Date;
    until?: Date;
    limit?: number;
}

export interface SessionLedgerEvent {
    eventId: string;
    timestamp: string;
    staffComponent: StaffComponent;
    actionType: string;
    agentId: string;
    source: string;
    entityType: string | null;
    entityId: string | null;
    key: string | null;
    reason: string | null;
    level: EventLevel;
    metadata: Record<string, unknown> | null;
}

export class SessionLedgerUnavailableError extends Error {
    readonly code = 'SESSION_LEDGER_UNAVAILABLE';

    constructor(message = 'staff_events table is missing. Create it before querying the session ledger.') {
        super(message);
        this.name = 'SessionLedgerUnavailableError';
    }
}

type SessionLedgerRow = {
    event_id: string;
    timestamp: Date | string;
    staff_component: StaffComponent;
    action_type: string;
    agent_id: string;
    source: string;
    entity_type: string | null;
    entity_id: string | null;
    key: string | null;
    reason: string | null;
    level: EventLevel;
    metadata: Record<string, unknown> | null;
};

function isMissingStaffEventsTable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /relation ["']?staff_events["']? does not exist/i.test(message);
}

function normalizeLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit)) return 100;
    return Math.max(1, Math.min(500, Math.floor(limit!)));
}

function rowToEvent(row: SessionLedgerRow): SessionLedgerEvent {
    return {
        eventId: row.event_id,
        timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
        staffComponent: row.staff_component,
        actionType: row.action_type,
        agentId: row.agent_id,
        source: row.source,
        entityType: row.entity_type ?? null,
        entityId: row.entity_id ?? null,
        key: row.key ?? null,
        reason: row.reason ?? null,
        level: row.level,
        metadata: row.metadata ?? null,
    };
}

export async function querySessionLedger(input: SessionLedgerQuery = {}): Promise<SessionLedgerEvent[]> {
    const clauses: Prisma.Sql[] = [];

    if (input.agentId?.trim()) {
        clauses.push(Prisma.sql`agent_id = ${input.agentId.trim()}`);
    }
    if (input.sessionId?.trim()) {
        clauses.push(Prisma.sql`metadata->>'sessionId' = ${input.sessionId.trim()}`);
    }
    if (input.actionType?.trim()) {
        clauses.push(Prisma.sql`action_type = ${input.actionType.trim()}`);
    }
    if (input.source?.trim()) {
        clauses.push(Prisma.sql`source = ${input.source.trim()}`);
    }
    if (input.level) {
        clauses.push(Prisma.sql`level = ${input.level}`);
    }
    if (input.since) {
        clauses.push(Prisma.sql`timestamp > ${input.since.toISOString()}::timestamptz`);
    }
    if (input.until) {
        clauses.push(Prisma.sql`timestamp <= ${input.until.toISOString()}::timestamptz`);
    }

    const whereClause = clauses.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`
        : Prisma.empty;

    try {
        const rows = await getDb().$queryRaw<SessionLedgerRow[]>(Prisma.sql`
            SELECT
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
            FROM staff_events
            ${whereClause}
            ORDER BY timestamp DESC
            LIMIT ${normalizeLimit(input.limit)}
        `);

        return rows.map(rowToEvent);
    } catch (error) {
        if (isMissingStaffEventsTable(error)) {
            throw new SessionLedgerUnavailableError();
        }
        throw error;
    }
}
