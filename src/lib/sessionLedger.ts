import { Prisma } from '../generated/prisma/client';
import { getDb } from '../library/client';
import type { EventLevel, StaffComponent } from './staffEventEmitter';

export interface SessionLedgerQuery {
    agentId?: string;
    sessionId?: string;
    actionType?: string;
    actionTypes?: string[];
    source?: string;
    host?: string;
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

export interface SessionLedgerLearning {
    actionType: string;
    summary: string;
    timestamp: string;
    source: string;
    host: string | null;
    sessionId: string | null;
    entityKey: string | null;
    reason: string | null;
}

export interface SessionLedgerLearningQuery {
    agentId?: string;
    sessionId?: string;
    source?: string;
    host?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    maxLearnings?: number;
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

function normalizeLearningLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit)) return 4;
    return Math.max(1, Math.min(10, Math.floor(limit!)));
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
    if (Array.isArray(input.actionTypes)) {
        const actionTypes = input.actionTypes
            .map((value) => value.trim())
            .filter(Boolean);
        if (actionTypes.length > 0) {
            clauses.push(Prisma.sql`action_type IN (${Prisma.join(actionTypes)})`);
        }
    }
    if (input.source?.trim()) {
        clauses.push(Prisma.sql`source = ${input.source.trim()}`);
    }
    if (input.host?.trim()) {
        clauses.push(Prisma.sql`metadata->>'host' = ${input.host.trim()}`);
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

const LEDGER_LEARNING_ACTIONS = new Set([
    'host_failure',
    'provider_fallback_used',
    'integration_probe_failed',
    'mandatory_recall_forced',
    'memory_injected',
    'checkpoint_written',
    'summary_written',
    'write_rejected',
    'write_escalated',
    'write_updated',
    'write_replaced',
    'write_created',
    'checkpoint_shared_breadcrumb_failed',
]);

function describeEvent(event: SessionLedgerEvent): string | null {
    const host = typeof event.metadata?.host === 'string' ? event.metadata.host : null;
    const entityKey = event.entityType && event.entityId && event.key
        ? `${event.entityType}/${event.entityId}/${event.key}`
        : event.entityType && event.entityId
            ? `${event.entityType}/${event.entityId}`
            : null;
    const error = typeof event.metadata?.error === 'string' ? event.metadata.error : null;
    const injectedKeys = Array.isArray(event.metadata?.injectedKeys)
        ? event.metadata!.injectedKeys.map((value) => String(value)).filter(Boolean)
        : [];

    switch (event.actionType) {
        case 'host_failure':
        case 'integration_probe_failed':
        case 'provider_fallback_used':
            return `${host ?? event.source} failure: ${event.reason ?? error ?? 'host error'}`;
        case 'mandatory_recall_forced':
            return event.key
                ? `recall policy forced a lookup for ${event.key}`
                : 'recall policy forced a memory lookup';
        case 'memory_injected':
            return injectedKeys.length > 0
                ? `memory injected from ${host ?? event.source}: ${injectedKeys.slice(0, 3).join(', ')}`
                : `memory injected from ${host ?? event.source}`;
        case 'checkpoint_written':
            return entityKey
                ? `shared checkpoint written for ${entityKey}`
                : 'shared checkpoint written';
        case 'summary_written':
            return entityKey
                ? `strict summary written for ${entityKey}`
                : 'strict summary written';
        case 'checkpoint_shared_breadcrumb_failed':
            return entityKey
                ? `shared checkpoint breadcrumb failed for ${entityKey}`
                : `shared checkpoint breadcrumb failed${error ? `: ${error}` : ''}`;
        case 'write_created':
            return entityKey ? `created ${entityKey}` : 'created durable fact';
        case 'write_updated':
            return entityKey ? `updated ${entityKey}` : 'updated durable fact';
        case 'write_replaced':
            return entityKey ? `replaced ${entityKey}` : 'replaced durable fact';
        case 'write_rejected':
            return entityKey
                ? `rejected write for ${entityKey}${event.reason ? `: ${event.reason}` : ''}`
                : 'rejected write';
        case 'write_escalated':
            return entityKey
                ? `escalated conflict for ${entityKey}`
                : 'escalated write conflict';
        default:
            return null;
    }
}

function eventToLearning(event: SessionLedgerEvent): SessionLedgerLearning | null {
    if (!LEDGER_LEARNING_ACTIONS.has(event.actionType)) {
        return null;
    }

    const summary = describeEvent(event);
    if (!summary) return null;

    return {
        actionType: event.actionType,
        summary,
        timestamp: event.timestamp,
        source: event.source,
        host: typeof event.metadata?.host === 'string' ? event.metadata.host : null,
        sessionId: typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : null,
        entityKey: event.entityType && event.entityId && event.key ? `${event.entityType}/${event.entityId}/${event.key}` : null,
        reason: event.reason ?? null,
    };
}

export async function summarizeSessionLedgerLearnings(
    input: SessionLedgerLearningQuery = {},
): Promise<SessionLedgerLearning[]> {
    const events = await querySessionLedger({
        agentId: input.agentId,
        sessionId: input.sessionId,
        source: input.source,
        host: input.host,
        since: input.since,
        until: input.until,
        limit: normalizeLimit(input.limit ?? 40),
    });

    const out: SessionLedgerLearning[] = [];
    const seen = new Set<string>();

    for (const event of events) {
        const learning = eventToLearning(event);
        if (!learning) continue;
        const identity = [
            learning.actionType,
            learning.entityKey ?? '',
            learning.reason ?? '',
            learning.summary,
        ].join('|');
        if (seen.has(identity)) continue;
        seen.add(identity);
        out.push(learning);
        if (out.length >= normalizeLearningLimit(input.maxLearnings)) {
            break;
        }
    }

    return out;
}
