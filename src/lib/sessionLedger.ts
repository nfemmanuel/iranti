import { Prisma } from '../generated/prisma/client';
import { getDb } from '../library/client';
import type { EventLevel, StaffComponent } from './staffEventEmitter';
import { ensureStaffEventsTable } from './staffEventsTable';

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
    category?: 'host' | 'recall' | 'persistence' | 'compliance' | 'event';
    evidenceActionTypes?: string[];
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

export interface SessionLedgerLearningProfile {
    scopesUsed: Array<'host' | 'task' | 'global'>;
    preferMemoryForAmbiguousTurns: boolean;
    priorityKeys: string[];
    summaries: string[];
    matchedTaskType: string | null;
    needsCheckpointReminder: boolean;
    checkpointReminder: string | null;
    missingWriteCategories: string[];
}

export interface MemoryAttributionSummary {
    injectionId: string;
    sessionId: string | null;
    agentId: string;
    source: string;
    host: string | null;
    surfacedAt: string;
    scoredAt: string | null;
    surfaced: boolean;
    used: boolean;
    helpful: boolean;
    injectedKeys: string[];
    injectedEntryIds: number[];
    evidenceKinds: string[];
    phase: string | null;
    reason: string | null;
}

export interface SessionLedgerLearningProfileQuery {
    agentId?: string;
    source?: string;
    host?: string;
    taskType?: string;
    since?: Date;
    until?: Date;
    limit?: number;
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

function normalizeProfileLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit)) return 60;
    return Math.max(10, Math.min(200, Math.floor(limit!)));
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
        const rows = await runLedgerQuery(whereClause, normalizeLimit(input.limit));

        return rows.map(rowToEvent);
    } catch (error) {
        if (isMissingStaffEventsTable(error)) {
            try {
                await ensureStaffEventsTable();
                const rows = await runLedgerQuery(whereClause, normalizeLimit(input.limit));
                return rows.map(rowToEvent);
            } catch (ensureError) {
                if (isMissingStaffEventsTable(ensureError)) {
                    throw new SessionLedgerUnavailableError();
                }
                throw ensureError;
            }
        }
        throw error;
    }
}

async function runLedgerQuery(whereClause: Prisma.Sql, limit: number): Promise<SessionLedgerRow[]> {
    return getDb().$queryRaw<SessionLedgerRow[]>(Prisma.sql`
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
        LIMIT ${limit}
    `);
}

const LEDGER_LEARNING_ACTIONS = new Set([
    'host_failure',
    'provider_fallback_used',
    'integration_probe_failed',
    'mandatory_recall_forced',
    'memory_injected',
    'memory_evidence_observed',
    'memory_injection_scored',
    'query_executed',
    'search_executed',
    'related_executed',
    'related_deep_executed',
    'whoknows_executed',
    'checkpoint_written',
    'checkpoint_availability_failed',
    'summary_written',
    'write_available',
    'write_availability_failed',
    'write_rejected',
    'write_escalated',
    'write_updated',
    'write_replaced',
    'write_created',
    'checkpoint_shared_breadcrumb_failed',
]);

const LEDGER_SUCCESS_ACTIONS = new Set([
    'memory_injected',
    'memory_injection_scored',
    'query_executed',
    'search_executed',
    'related_executed',
    'related_deep_executed',
    'whoknows_executed',
    'checkpoint_written',
    'write_available',
    'summary_written',
    'write_created',
    'write_updated',
    'write_replaced',
]);

const LEDGER_ACTIVITY_ACTIONS = new Set([
    'query_executed',
    'search_executed',
    'related_executed',
    'related_deep_executed',
    'whoknows_executed',
    'observe_completed',
    'attend_completed',
    'memory_injected',
    'memory_not_injected',
    'memory_evidence_observed',
    'memory_injection_scored',
    'mandatory_recall_forced',
]);

const LEDGER_PERSISTENCE_ACTIONS = new Set([
    'checkpoint_written',
    'write_available',
    'summary_written',
    'write_created',
    'write_updated',
    'write_replaced',
]);

const LEDGER_FAILURE_ACTIONS = new Set([
    'host_failure',
    'integration_probe_failed',
    'provider_fallback_used',
    'checkpoint_availability_failed',
    'write_availability_failed',
    'write_rejected',
    'write_escalated',
    'checkpoint_shared_breadcrumb_failed',
]);

const LEDGER_DISCOVERY_ACTIONS = new Set([
    'query_executed',
    'search_executed',
    'related_executed',
    'related_deep_executed',
    'whoknows_executed',
    'observe_completed',
    'memory_injected',
    'memory_evidence_observed',
    'memory_injection_scored',
    'mandatory_recall_forced',
]);

const LEDGER_REQUIRED_WRITE_CATEGORY_LABELS: Record<string, string> = {
    findings: 'what you found',
    validated_results: 'what worked',
    failed_paths: 'what failed',
    file_changes: 'what changed',
    risks_and_next_steps: 'what remains risky and what happens next',
};

const TASK_TOKEN_STOPWORDS = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'into',
    'that',
    'this',
    'what',
    'when',
    'where',
    'which',
    'while',
    'about',
    'need',
    'needs',
    'work',
    'working',
    'task',
    'tasks',
    'project',
    'agent',
    'session',
    'continue',
    'continuing',
]);

// Maps common engineering task vocabulary to canonical forms so that synonymous
// task descriptions score well even when they share no raw tokens.
// Keys must be 4+ characters (matching the tokenizeTaskText length filter).
const TASK_TOKEN_SYNONYMS: Record<string, string> = {
    // Bug resolution
    'fixing': 'repair',
    'fixed': 'repair',
    'resolve': 'repair',
    'resolving': 'repair',
    'resolved': 'repair',
    'debug': 'repair',
    'debugging': 'repair',
    'debugged': 'repair',
    'patch': 'repair',
    'patching': 'repair',
    'repair': 'repair',
    'repairing': 'repair',
    'troubleshoot': 'repair',
    'troubleshooting': 'repair',
    // Container / Docker
    'docker': 'container',
    'container': 'container',
    'containers': 'container',
    // Startup / init / launch
    'startup': 'startup',
    'boot': 'startup',
    'init': 'startup',
    'initialize': 'startup',
    'initialise': 'startup',
    'initializing': 'startup',
    'launch': 'startup',
    'launching': 'startup',
    // Authentication
    'auth': 'auth',
    'authentication': 'auth',
    'authenticate': 'auth',
    'login': 'auth',
    'signin': 'auth',
    'authorization': 'auth',
    'authorize': 'auth',
    // Database
    'database': 'database',
    'postgres': 'database',
    'postgresql': 'database',
    'prisma': 'database',
    // Errors / failures
    'error': 'error',
    'errors': 'error',
    'bugs': 'error',
    'failure': 'error',
    'failures': 'error',
    'problem': 'error',
    'problems': 'error',
    'issue': 'error',
    'issues': 'error',
    'fault': 'error',
    // Memory / injection (Iranti-domain)
    'memory': 'memory',
    'injection': 'memory',
    'inject': 'memory',
    'injecting': 'memory',
    // Performance
    'performance': 'performance',
    'optimize': 'performance',
    'optimise': 'performance',
    'optimizing': 'performance',
    'latency': 'performance',
    'slow': 'performance',
    'speed': 'performance',
};

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
        case 'memory_evidence_observed': {
            const evidenceKind = typeof event.metadata?.evidenceKind === 'string' ? event.metadata.evidenceKind : 'memory_evidence';
            return `memory evidence observed from ${host ?? event.source}: ${evidenceKind}`;
        }
        case 'memory_injection_scored': {
            const used = event.metadata?.used === true;
            const helpful = event.metadata?.helpful === true;
            return `memory injection scored from ${host ?? event.source}: used=${used} helpful=${helpful}`;
        }
        case 'checkpoint_written':
            return entityKey
                ? `shared checkpoint written for ${entityKey}`
                : 'shared checkpoint written';
        case 'checkpoint_availability_failed':
            return entityKey
                ? `checkpoint availability failed for ${entityKey}`
                : `checkpoint availability failed${error ? `: ${error}` : ''}`;
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
        case 'write_available':
            return entityKey ? `write availability verified for ${entityKey}` : 'write availability verified';
        case 'write_availability_failed':
            return entityKey
                ? `write availability failed for ${entityKey}`
                : `write availability failed${error ? `: ${error}` : ''}`;
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
        category: 'event',
        evidenceActionTypes: [event.actionType],
    };
}

function latestTimestamp(events: SessionLedgerEvent[]): string {
    return events
        .map((event) => event.timestamp)
        .sort((left, right) => right.localeCompare(left))[0] ?? new Date(0).toISOString();
}

function distinct<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

function inferMissingWriteCategories(sessionEvents: SessionLedgerEvent[]): string[] {
    const categories = new Set<string>();
    const activityCount = sessionEvents.filter((event) => LEDGER_ACTIVITY_ACTIONS.has(event.actionType)).length;
    const discoveryCount = sessionEvents.filter((event) => LEDGER_DISCOVERY_ACTIONS.has(event.actionType)).length;
    const failureCount = sessionEvents.filter((event) => LEDGER_FAILURE_ACTIONS.has(event.actionType)).length;
    const successCount = sessionEvents.filter((event) => LEDGER_SUCCESS_ACTIONS.has(event.actionType)).length;

    if (discoveryCount > 0 || activityCount >= 4) {
        categories.add('findings');
        categories.add('risks_and_next_steps');
    }
    if (successCount > 0) {
        categories.add('validated_results');
    }
    if (failureCount > 0) {
        categories.add('failed_paths');
    }
    if (activityCount >= 8) {
        categories.add('file_changes');
    }

    return Array.from(categories);
}

function formatWriteCategoryList(categories: string[]): string {
    const labels = categories
        .map((category) => LEDGER_REQUIRED_WRITE_CATEGORY_LABELS[category] ?? category)
        .filter(Boolean);
    if (labels.length === 0) {
        return 'what you found and what happens next';
    }
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function tokenizeTaskText(text: string | null | undefined): string[] {
    if (!text) return [];
    return distinct(
        text
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .map((token) => token.trim())
            .filter((token) => token.length >= 4 && !TASK_TOKEN_STOPWORDS.has(token))
    );
}

function expandTokenSynonym(token: string): string {
    return TASK_TOKEN_SYNONYMS[token] ?? token;
}

function scoreTaskSimilarity(left: string | null | undefined, right: string | null | undefined): number {
    const leftTokens = tokenizeTaskText(left);
    const rightTokens = tokenizeTaskText(right);
    if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

    // Raw Jaccard on original tokens.
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
    const union = new Set([...leftSet, ...rightSet]).size;
    const rawScore = union === 0 ? 0 : overlap / union;

    // Synonym-expanded Jaccard: canonicalize each token then recompute.
    // This catches synonymous task descriptions that share no raw tokens
    // (e.g. "fix docker bug" vs "repair container startup issue").
    const leftExpanded = distinct(leftTokens.map(expandTokenSynonym));
    const rightExpanded = distinct(rightTokens.map(expandTokenSynonym));
    const leftExpandedSet = new Set(leftExpanded);
    const rightExpandedSet = new Set(rightExpanded);
    const expandedOverlap = leftExpanded.filter((token) => rightExpandedSet.has(token)).length;
    const expandedUnion = new Set([...leftExpandedSet, ...rightExpandedSet]).size;
    const expandedScore = expandedUnion === 0 ? 0 : expandedOverlap / expandedUnion;

    return Math.max(rawScore, expandedScore);
}

function taskSummaryForEvent(event: SessionLedgerEvent): string | null {
    const directTask = typeof event.metadata?.task === 'string' ? event.metadata.task : null;
    const summarizedTask = typeof event.metadata?.taskSummary === 'string' ? event.metadata.taskSummary : null;
    return directTask ?? summarizedTask ?? null;
}

function scopeEventsByTaskType(events: SessionLedgerEvent[], taskType: string | undefined): {
    matchedTaskType: string | null;
    events: SessionLedgerEvent[];
} {
    if (!taskType?.trim()) {
        return {
            matchedTaskType: null,
            events: [],
        };
    }

    const scored = events
        .map((event) => ({
            event,
            taskSummary: taskSummaryForEvent(event),
            score: scoreTaskSimilarity(taskSummaryForEvent(event), taskType),
        }))
        .filter((entry) => entry.taskSummary && entry.score >= 0.34)
        .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
        return {
            matchedTaskType: null,
            events: [],
        };
    }

    const matchingSessionIds = new Set(
        scored
            .map((entry) => typeof entry.event.metadata?.sessionId === 'string' ? entry.event.metadata.sessionId : null)
            .filter((value): value is string => Boolean(value))
    );

    const scoped = matchingSessionIds.size === 0
        ? scored.map((entry) => entry.event)
        : events.filter((event) => {
            const sessionId = typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : null;
            return sessionId ? matchingSessionIds.has(sessionId) : false;
        });

    return {
        matchedTaskType: scored[0]?.taskSummary ?? null,
        events: scoped,
    };
}

function extractEventEntityKeys(event: SessionLedgerEvent): string[] {
    const directEntityKey = event.entityType && event.entityId && event.key
        ? [`${event.entityType}/${event.entityId}/${event.key}`]
        : [];
    const injectedKeys = Array.isArray(event.metadata?.injectedKeys)
        ? event.metadata!.injectedKeys.map((value) => String(value)).filter(Boolean)
        : [];
    return distinct([...directEntityKey, ...injectedKeys]);
}

function buildPriorityKeys(events: SessionLedgerEvent[]): string[] {
    const counts = new Map<string, number>();
    const lastSeen = new Map<string, string>();

    for (const event of events) {
        if (!LEDGER_SUCCESS_ACTIONS.has(event.actionType) && event.actionType !== 'mandatory_recall_forced') {
            continue;
        }
        for (const entityKey of extractEventEntityKeys(event)) {
            const parts = entityKey.split('/');
            const key = parts.length >= 3 ? parts.slice(2).join('/') : null;
            if (!key || key === 'attendant_state') continue;
            counts.set(key, (counts.get(key) ?? 0) + 1);
            lastSeen.set(key, event.timestamp);
        }
    }

    return Array.from(counts.entries())
        .sort((left, right) => (
            (right[1] - left[1])
            || (lastSeen.get(right[0]) ?? '').localeCompare(lastSeen.get(left[0]) ?? '')
            || left[0].localeCompare(right[0])
        ))
        .slice(0, 6)
        .map(([key]) => key);
}

function scopeSummaries(events: SessionLedgerEvent[]): string[] {
    return [
        ...buildHostLearnings(events),
        ...buildRecallLearnings(events),
        ...buildPersistenceLearnings(events),
        ...buildComplianceLearnings(events),
    ]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .map((learning) => learning.summary)
        .slice(0, 2);
}

function scopeSupportsAmbiguousMemory(events: SessionLedgerEvent[]): boolean {
    // Strongest signal: a memory_injected event followed by a persistence event
    // in the same session — the agent received injected context and then wrote
    // something durable, indicating the injection was productive.
    const sessions = new Map<string, SessionLedgerEvent[]>();
    for (const event of events) {
        const sessionId = typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : '_unknown';
        const bucket = sessions.get(sessionId) ?? [];
        bucket.push(event);
        sessions.set(sessionId, bucket);
    }

    for (const sessionEvents of sessions.values()) {
        const sorted = sessionEvents.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        let seenInjection = false;
        for (const event of sorted) {
            if (event.actionType === 'memory_injected') {
                seenInjection = true;
            } else if (seenInjection && LEDGER_PERSISTENCE_ACTIONS.has(event.actionType)) {
                return true;
            }
        }
    }

    // Advisory-first fallback: injection was used in this scope even if no downstream
    // persistence was confirmed — the pattern still signals this host uses injection.
    if (events.some((event) => event.actionType === 'memory_injected')) {
        return true;
    }

    // No injection history: fall back to whether the scope produced any durable
    // output at all. Retrieval-only sessions (query/search without writes) do not
    // qualify — they carry no signal that ambiguous injection would be useful.
    return events.some((event) => LEDGER_PERSISTENCE_ACTIONS.has(event.actionType));
}

function buildComplianceLearnings(events: SessionLedgerEvent[]): SessionLedgerLearning[] {
    const sessions = new Map<string, SessionLedgerEvent[]>();
    for (const event of events) {
        const sessionId = typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : null;
        if (!sessionId) continue;
        const bucket = sessions.get(sessionId) ?? [];
        bucket.push(event);
        sessions.set(sessionId, bucket);
    }

    const out: SessionLedgerLearning[] = [];
    for (const [sessionId, sessionEvents] of sessions.entries()) {
        const activityCount = sessionEvents.filter((event) => LEDGER_ACTIVITY_ACTIONS.has(event.actionType)).length;
        const hasPersistence = sessionEvents.some((event) => LEDGER_PERSISTENCE_ACTIONS.has(event.actionType));
        if (activityCount < 4 || hasPersistence) {
            continue;
        }

        const missingWriteCategories = inferMissingWriteCategories(sessionEvents);

        const host = typeof sessionEvents[0]?.metadata?.host === 'string'
            ? String(sessionEvents[0].metadata?.host)
            : (sessionEvents[0]?.source ?? null);
        const summary = `Recent compliance lesson: ${host ?? 'this host'} left an under-logged run after substantial retrieval work without a checkpoint or durable write. This is non-compliant for Iranti; before the next pause, write ${formatWriteCategoryList(missingWriteCategories)} and checkpoint shared progress.`;
        out.push({
            actionType: 'checkpoint_discipline_lesson',
            summary,
            timestamp: latestTimestamp(sessionEvents),
            source: sessionEvents[0]?.source ?? 'internal',
            host: host || null,
            sessionId,
            entityKey: null,
            reason: 'missing_checkpoint_after_activity',
            category: 'compliance',
            evidenceActionTypes: distinct(sessionEvents.map((event) => event.actionType)),
        });
    }

    return out;
}

function describeHostCapabilities(events: SessionLedgerEvent[]): string | null {
    const capabilities = distinct(events.flatMap((event) => {
        switch (event.actionType) {
            case 'memory_injected':
                return ['memory injection'];
            case 'query_executed':
                return ['exact lookup'];
            case 'search_executed':
                return ['search'];
            case 'related_executed':
            case 'related_deep_executed':
                return ['relationship lookup'];
            case 'whoknows_executed':
                return ['agent lookup'];
            case 'checkpoint_written':
                return ['shared checkpoints'];
            case 'summary_written':
                return ['strict summaries'];
            case 'write_available':
            case 'write_created':
            case 'write_updated':
            case 'write_replaced':
                return ['durable writes'];
            default:
                return [];
        }
    }));

    if (capabilities.length === 0) return null;
    if (capabilities.length === 1) return capabilities[0];
    if (capabilities.length === 2) return `${capabilities[0]} and ${capabilities[1]}`;
    return `${capabilities.slice(0, -1).join(', ')}, and ${capabilities[capabilities.length - 1]}`;
}

function summarizeFailureReasons(events: SessionLedgerEvent[]): string {
    const reasons = distinct(events.map((event) => event.reason ?? 'host error').filter(Boolean));
    return reasons.slice(0, 2).join('; ');
}

function buildHostLearnings(events: SessionLedgerEvent[]): SessionLedgerLearning[] {
    const byHost = new Map<string, SessionLedgerEvent[]>();
    for (const event of events) {
        const host = typeof event.metadata?.host === 'string' ? event.metadata.host : event.source;
        const key = `${event.source}|${host}`;
        const bucket = byHost.get(key) ?? [];
        bucket.push(event);
        byHost.set(key, bucket);
    }

    const out: SessionLedgerLearning[] = [];
    for (const [identity, hostEvents] of byHost.entries()) {
        const [source, hostName] = identity.split('|');
        const failures = hostEvents.filter((event) => (
            event.actionType === 'host_failure'
            || event.actionType === 'integration_probe_failed'
            || event.actionType === 'provider_fallback_used'
        ));
        const successes = hostEvents.filter((event) => !failures.includes(event));
        if (failures.length === 0 && successes.length === 0) continue;

        const capabilitySummary = describeHostCapabilities(successes);
        let summary: string | null = null;
        if (failures.length > 0 && capabilitySummary) {
            summary = `Recent host lesson: ${hostName} hit ${summarizeFailureReasons(failures)}, but ${source} still completed ${capabilitySummary}.`;
        } else if (failures.length > 0) {
            summary = `Recent host lesson: ${hostName} hit ${summarizeFailureReasons(failures)}.`;
        } else if (capabilitySummary) {
            summary = `Recent host lesson: ${hostName} successfully completed ${capabilitySummary}.`;
        }
        if (!summary) continue;

        out.push({
            actionType: 'host_lesson',
            summary,
            timestamp: latestTimestamp(hostEvents),
            source,
            host: hostName || null,
            sessionId: typeof hostEvents[0]?.metadata?.sessionId === 'string' ? String(hostEvents[0].metadata?.sessionId) : null,
            entityKey: null,
            reason: failures[0]?.reason ?? null,
            category: 'host',
            evidenceActionTypes: distinct(hostEvents.map((event) => event.actionType)),
        });
    }

    return out;
}

function buildRecallLearnings(events: SessionLedgerEvent[]): SessionLedgerLearning[] {
    const recalls = events.filter((event) => event.actionType === 'mandatory_recall_forced');
    const injections = events.filter((event) => event.actionType === 'memory_injected');
    const out: SessionLedgerLearning[] = [];

    for (const recall of recalls) {
        const entityKey = recall.entityType && recall.entityId && recall.key
            ? `${recall.entityType}/${recall.entityId}/${recall.key}`
            : null;
        const matchingInjection = injections.find((event) => {
            const injectedKeys = Array.isArray(event.metadata?.injectedKeys)
                ? event.metadata!.injectedKeys.map((value) => String(value))
                : [];
            return entityKey ? injectedKeys.includes(entityKey) : event.reason === recall.reason;
        });
        if (!matchingInjection) continue;
        out.push({
            actionType: 'recall_lesson',
            summary: entityKey
                ? `Recent recall lesson: policy-forced recall successfully injected ${entityKey}.`
                : 'Recent recall lesson: policy-forced recall successfully injected needed memory.',
            timestamp: latestTimestamp([recall, matchingInjection]),
            source: recall.source,
            host: typeof recall.metadata?.host === 'string' ? recall.metadata.host : null,
            sessionId: typeof recall.metadata?.sessionId === 'string' ? recall.metadata.sessionId : null,
            entityKey,
            reason: recall.reason ?? null,
            category: 'recall',
            evidenceActionTypes: ['mandatory_recall_forced', 'memory_injected'],
        });
    }

    return out;
}

function buildPersistenceLearnings(events: SessionLedgerEvent[]): SessionLedgerLearning[] {
    const persistenceEvents = events.filter((event) => (
        event.actionType === 'checkpoint_written'
        || event.actionType === 'summary_written'
        || event.actionType === 'write_available'
        || event.actionType === 'write_created'
        || event.actionType === 'write_updated'
        || event.actionType === 'write_replaced'
    ));
    const byEntity = new Map<string, SessionLedgerEvent[]>();
    for (const event of persistenceEvents) {
        const entityKey = event.entityType && event.entityId && event.key
            ? `${event.entityType}/${event.entityId}/${event.key}`
            : null;
        if (!entityKey) continue;
        const bucket = byEntity.get(entityKey) ?? [];
        bucket.push(event);
        byEntity.set(entityKey, bucket);
    }

    const out: SessionLedgerLearning[] = [];
    for (const [entityKey, entityEvents] of byEntity.entries()) {
        const hasCheckpoint = entityEvents.some((event) => event.actionType === 'checkpoint_written');
        const hasDurable = entityEvents.some((event) => (
            event.actionType === 'summary_written'
            || event.actionType === 'write_available'
            || event.actionType === 'write_created'
            || event.actionType === 'write_updated'
            || event.actionType === 'write_replaced'
        ));
        if (!hasCheckpoint && !hasDurable) continue;

        let summary: string;
        if (hasCheckpoint && hasDurable) {
            summary = `Recent persistence lesson: ${entityKey} is being kept current through shared checkpoints and durable writes.`;
        } else if (hasCheckpoint) {
            summary = `Recent persistence lesson: ${entityKey} is being handed off through shared checkpoints.`;
        } else {
            summary = `Recent persistence lesson: ${entityKey} is being maintained through durable writes.`;
        }

        out.push({
            actionType: 'persistence_lesson',
            summary,
            timestamp: latestTimestamp(entityEvents),
            source: entityEvents[0]?.source ?? 'internal',
            host: typeof entityEvents[0]?.metadata?.host === 'string' ? String(entityEvents[0].metadata?.host) : null,
            sessionId: typeof entityEvents[0]?.metadata?.sessionId === 'string' ? String(entityEvents[0].metadata?.sessionId) : null,
            entityKey,
            reason: null,
            category: 'persistence',
            evidenceActionTypes: distinct(entityEvents.map((event) => event.actionType)),
        });
    }

    return out;
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

    const synthesized = [
        ...buildHostLearnings(events),
        ...buildRecallLearnings(events),
        ...buildPersistenceLearnings(events),
        ...buildComplianceLearnings(events),
    ].sort((left, right) => right.timestamp.localeCompare(left.timestamp));

    for (const learning of synthesized) {
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
            return out;
        }
    }

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

export async function summarizeMemoryAttribution(input: SessionLedgerQuery = {}): Promise<MemoryAttributionSummary[]> {
    const events = await querySessionLedger({
        ...input,
        actionTypes: ['memory_injected', 'memory_injection_scored'],
        limit: normalizeLimit(input.limit ?? 200),
    });

    const byInjectionId = new Map<string, MemoryAttributionSummary>();

    for (const event of events.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
        const injectionId = typeof event.metadata?.injectionId === 'string'
            ? event.metadata.injectionId
            : null;
        if (!injectionId) {
            continue;
        }

        const existing = byInjectionId.get(injectionId);
        const injectedKeys = Array.isArray(event.metadata?.injectedKeys)
            ? event.metadata!.injectedKeys.map((value) => String(value)).filter(Boolean)
            : existing?.injectedKeys ?? [];
        const injectedEntryIds = Array.isArray(event.metadata?.injectedEntryIds)
            ? event.metadata!.injectedEntryIds
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value))
            : existing?.injectedEntryIds ?? [];
        const evidenceKinds = Array.isArray(event.metadata?.evidenceKinds)
            ? event.metadata!.evidenceKinds.map((value) => String(value)).filter(Boolean)
            : existing?.evidenceKinds ?? [];
        const sessionId = typeof event.metadata?.sessionId === 'string'
            ? event.metadata.sessionId
            : existing?.sessionId ?? null;
        const host = typeof event.metadata?.host === 'string'
            ? event.metadata.host
            : existing?.host ?? null;
        const phase = typeof event.metadata?.phase === 'string'
            ? event.metadata.phase
            : existing?.phase ?? null;

        byInjectionId.set(injectionId, {
            injectionId,
            sessionId,
            agentId: event.agentId,
            source: event.source,
            host,
            surfacedAt: existing?.surfacedAt ?? event.timestamp,
            scoredAt: event.actionType === 'memory_injection_scored'
                ? event.timestamp
                : (existing?.scoredAt ?? null),
            surfaced: true,
            used: event.actionType === 'memory_injection_scored'
                ? event.metadata?.used === true
                : (existing?.used ?? false),
            helpful: event.actionType === 'memory_injection_scored'
                ? event.metadata?.helpful === true
                : (existing?.helpful ?? false),
            injectedKeys,
            injectedEntryIds,
            evidenceKinds,
            phase,
            reason: event.reason ?? existing?.reason ?? null,
        });
    }

    return Array.from(byInjectionId.values()).sort((left, right) => right.surfacedAt.localeCompare(left.surfacedAt));
}

export async function buildSessionLedgerLearningProfile(
    input: SessionLedgerLearningProfileQuery = {},
): Promise<SessionLedgerLearningProfile | null> {
    const events = await querySessionLedger({
        agentId: input.agentId,
        source: input.source,
        since: input.since,
        until: input.until,
        limit: normalizeProfileLimit(input.limit),
    });

    if (events.length === 0) {
        return null;
    }

    const hostEvents = input.host?.trim()
        ? events.filter((event) => {
            const host = typeof event.metadata?.host === 'string' ? event.metadata.host : null;
            return host === input.host;
        })
        : [];
    const taskScope = scopeEventsByTaskType(events, input.taskType);
    const taskEvents = taskScope.events;
    const globalEvents = events;

    const scopes: Array<{ name: 'host' | 'task' | 'global'; events: SessionLedgerEvent[] }> = [
        { name: 'host', events: hostEvents },
        { name: 'task', events: taskEvents },
        { name: 'global', events: globalEvents },
    ];

    const scopesUsed: Array<'host' | 'task' | 'global'> = [];
    const summaries: string[] = [];
    const priorityKeys: string[] = [];
    let preferMemoryForAmbiguousTurns = false;
    let checkpointReminder: string | null = null;
    let missingWriteCategories: string[] = [];

    for (const scope of scopes) {
        if (scope.events.length === 0) continue;
        scopesUsed.push(scope.name);
        if (scopeSupportsAmbiguousMemory(scope.events)) {
            preferMemoryForAmbiguousTurns = true;
        }
        if (!checkpointReminder) {
            const complianceLearning = buildComplianceLearnings(scope.events)[0] ?? null;
            checkpointReminder = complianceLearning?.summary ?? null;
            missingWriteCategories = complianceLearning ? inferMissingWriteCategories(scope.events) : [];
        }
        for (const summary of scopeSummaries(scope.events)) {
            if (!summaries.includes(summary)) {
                summaries.push(summary);
            }
        }
        for (const key of buildPriorityKeys(scope.events)) {
            if (!priorityKeys.includes(key)) {
                priorityKeys.push(key);
            }
        }
    }

    if (!preferMemoryForAmbiguousTurns && summaries.length === 0 && priorityKeys.length === 0) {
        return null;
    }

    return {
        scopesUsed,
        preferMemoryForAmbiguousTurns,
        priorityKeys: priorityKeys.slice(0, 6),
        summaries: summaries.slice(0, 4),
        matchedTaskType: taskScope.matchedTaskType,
        needsCheckpointReminder: Boolean(checkpointReminder),
        checkpointReminder,
        missingWriteCategories,
    };
}
