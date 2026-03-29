import 'dotenv/config';
import { initDb } from '../library/client';
import {
    IStaffEventEmitter,
    NoopEventEmitter,
    StaffEventInput,
    StaffEvent,
    buildStaffEvent,
} from '../lib/staffEventEmitter';
import { setStaffEventEmitter, getStaffEventEmitter, resetStaffEventEmitter } from '../lib/staffEventRegistry';
import { librarianWrite, librarianIngest } from '../librarian';
import type {
    WorkingMemoryBrief,
    AttendResult,
    SessionSummary as AttendantSessionSummary,
    SessionCheckpointSummary as AttendantSessionCheckpointSummary,
    SessionOperatorState as AttendantSessionOperatorState,
} from '../attendant';
import { getAttendant, AttendantInstance } from '../attendant/registry';
import { runArchivist } from '../archivist';
import { summarizeSessionState } from '../attendant/AttendantInstance';
import { findArchiveAsOf, findArchiveHistory, findEntriesByEntity, findEntry, listAttendantStateEntries, recordKnowledgeEntryAccess, searchEntriesHybrid } from '../library/queries';
import { createRelationship, getRelated, getRelatedDeep, RelatedEntity } from '../library/relationships';
import { registerAgent, getAgent, whoKnows, listAgents, assignToTeam, AgentProfile, AgentRecord } from '../library/agent-registry';
import { resolveEntity } from '../library/entity-resolution';
import { getPersonalRecallEntities, isPersonalMemoryKey } from '../lib/autoRemember';
import { configureMock, MockConfig } from '../lib/providers/mock';
import { EntityType } from '../types';
import { ArchivedReason, ResolutionOutcome, ResolutionState } from '../generated/prisma/client';
import { querySessionLedger, SessionLedgerEvent, SessionLedgerQuery } from '../lib/sessionLedger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IrantiConfig {
    connectionString?: string;
    llmProvider?: string;
    sessionLedgerSource?: string;
    sessionLedgerHost?: string | null;
    /**
     * Optional event emitter for observability integrations (e.g., the Iranti
     * Control Plane). Defaults to a no-op emitter if not provided.
     * The emitter MUST NOT throw — all errors must be caught internally.
     */
    staffEventEmitter?: IStaffEventEmitter;
}

export interface WriteInput {
    entity: string;           // Format: "entityType/entityId" e.g. "researcher/jane_smith"
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
    agent: string;
    validFrom?: Date;
    validUntil?: Date | null;
    requestId?: string;
    properties?: Record<string, unknown>;
}

export interface IngestInput {
    entity: string;
    content: string;
    source: string;
    confidence: number;
    agent: string;
}

export interface HandshakeInput {
    agent?: string;
    agentId?: string;
    task: string;
    recentMessages: string[];
}

export type SessionStatus = 'active' | 'interrupted' | 'completed' | 'abandoned';

export interface SessionCheckpointPayload {
    currentStep?: string;
    nextStep?: string;
    openRisks?: string[];
    recentOutputs?: string[];
    entityTargets?: string[];
    notes?: string;
}

export interface SessionCheckpointRecord {
    sessionId: string;
    task: string;
    taskFingerprint: string;
    status: SessionStatus;
    startedAt: string;
    lastHeartbeatAt: string;
    updatedAt: string;
    checkpoint: SessionCheckpointPayload;
    interruptedAt?: string;
    completedAt?: string;
    abandonedAt?: string;
    resumedAt?: string;
}

export interface SessionRecoveryInfo {
    available: boolean;
    sessionId: string;
    task: string;
    taskFingerprint: string;
    matchedCurrentTask: boolean;
    matchConfidence: number;
    recommendation: 'resume' | 'review' | 'ignore';
    summary: string;
    lastHeartbeatAt: string;
    interruptedAt: string;
    checkpoint: SessionCheckpointPayload | null;
}

export interface SessionCheckpointInput {
    agent?: string;
    agentId?: string;
    task: string;
    recentMessages: string[];
    checkpoint: SessionCheckpointPayload | string | Record<string, unknown>;
    sessionId?: string;
    heartbeatAt?: string;
}

export interface SessionActionInput {
    agent?: string;
    agentId?: string;
    sessionId?: string;
}

export interface SessionInspectionInput {
    agent?: string;
    agentId?: string;
    task?: string;
    recentMessages?: string[];
}

export type SessionListSort = 'operator' | 'updated_desc' | 'agent_asc';

export interface SessionListInput {
    agentId?: string;
    operatorState?: SessionOperatorState;
    staleOnly?: boolean;
    limit?: number;
    sort?: SessionListSort;
}

export interface SessionInspection {
    agentId: string;
    hasCheckpoint: boolean;
    sessionCheckpoint: SessionCheckpointRecord | null;
    sessionRecovery: SessionRecoveryInfo | null;
    persistedBriefGeneratedAt?: string;
    summary: SessionSummary;
}

export interface SessionLedgerInput extends SessionLedgerQuery {}

export type SessionOperatorState = AttendantSessionOperatorState;

export interface SessionCheckpointSummary extends AttendantSessionCheckpointSummary {}

export interface SessionSummary extends AttendantSessionSummary {}

export interface TemporalQueryOptions {
    asOf?: Date;
    includeExpired?: boolean;
    includeContested?: boolean;
}

export interface QueryResult {
    found: boolean;
    value?: unknown;
    summary?: string;
    confidence?: number;
    source?: string;
    validFrom?: Date | null;
    validUntil?: Date | null;
    contested?: boolean;
    fromArchive?: boolean;
    archivedReason?: ArchivedReason | null;
    resolutionState?: ResolutionState | null;
    resolutionOutcome?: ResolutionOutcome | null;
    resolvedEntity?: string;
    inputEntity?: string;
}

export interface HistoryEntry {
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
    validFrom: Date;
    validUntil: Date | null;
    isCurrent: boolean;
    contested: boolean;
    archivedReason: ArchivedReason | null;
    resolutionState: ResolutionState | null;
    resolutionOutcome: ResolutionOutcome | null;
}

export interface HybridSearchInput {
    query: string;
    limit?: number;
    entityType?: string;
    entityId?: string;
    lexicalWeight?: number;
    vectorWeight?: number;
    minScore?: number;
}

export interface HybridSearchResult {
    id: number;
    entity: string;
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
    validUntil?: Date | null;
    lexicalScore: number;
    vectorScore: number;
    score: number;
}

export interface WriteResult {
    action: 'created' | 'updated' | 'escalated' | 'rejected';
    key: string;
    reason: string;
    resolvedEntity?: string;
    inputEntity?: string;
}

export interface IngestFactResult {
    action: WriteResult['action'] | 'failed';
    key: string;
    reason: string;
}

export interface IngestResult {
    extractedCandidates: number;
    written: number;
    rejected: number;
    escalated: number;
    skippedMalformed: number;
    reason?: string;
    facts: IngestFactResult[];
}

export interface ObserveInput {
    agent?: string;
    agentId?: string;
    currentContext: string;
    maxFacts?: number;
    entityHints?: string[];
}

export interface AttendInput extends ObserveInput {
    latestMessage?: string;
    forceInject?: boolean;
    suppressEvents?: boolean;
}

type SessionLedgerContext = {
    source?: string;
    host?: string | null;
};

// ─── Entity Parsing ──────────────────────────────────────────────────────────

function parseEntity(entity: string): { entityType: EntityType; entityId: string } {
    if (!entity || typeof entity !== 'string') {
        throw new Error('Entity must be a non-empty string.');
    }
    const raw = entity.trim();
    if (!raw) {
        throw new Error('Entity must be a non-empty string.');
    }

    const heuristicEntityId = (name: string): string =>
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');

    if (!raw.includes('/')) {
        const normalized = heuristicEntityId(raw);
        if (!normalized) {
            throw new Error(`Unable to parse entity: "${entity}"`);
        }
        const entityId = normalized.startsWith('project_') ? normalized : `project_${normalized}`;
        return {
            entityType: 'project' as EntityType,
            entityId,
        };
    }

    const parts = raw.split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error(
            `Invalid entity format: "${entity}". Expected "entityType/entityId" e.g. "researcher/jane_smith". Neither part can be empty.`
        );
    }
    const entityType = parts[0] as EntityType;
    const entityId = parts.slice(1).join('/');
    return { entityType, entityId };
}

function resolveAgentId(input: { agent?: string; agentId?: string }, operation: string): string {
    const agentId = input.agentId?.trim() || input.agent?.trim();
    if (!agentId) {
        throw new Error(`${operation} requires agentId (agent is accepted as a legacy alias).`);
    }
    return agentId;
}

function sessionOperatorPriority(summary: SessionSummary): number {
    switch (summary.operatorState) {
        case 'interrupted':
            return 0;
        case 'active':
            return 1;
        case 'completed':
            return 2;
        case 'abandoned':
            return 3;
        case 'none':
        default:
            return 4;
    }
}

function sessionTimestamp(summary: SessionSummary): number {
    const candidate = summary.updatedAt
        ?? summary.lastHeartbeatAt
        ?? summary.startedAt
        ?? summary.persistedBriefGeneratedAt
        ?? null;
    if (!candidate) return 0;
    const parsed = new Date(candidate).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareSessionSummaries(a: SessionSummary, b: SessionSummary, sort: SessionListSort): number {
    if (sort === 'agent_asc') {
        return a.agentId.localeCompare(b.agentId);
    }
    if (sort === 'updated_desc') {
        return sessionTimestamp(b) - sessionTimestamp(a) || a.agentId.localeCompare(b.agentId);
    }

    return (
        sessionOperatorPriority(a) - sessionOperatorPriority(b)
        || sessionTimestamp(b) - sessionTimestamp(a)
        || a.agentId.localeCompare(b.agentId)
    );
}

async function resolveQueryEntity(entity: string): Promise<{
    entityType: EntityType;
    entityId: string;
    canonicalEntity: string;
}> {
    const parsed = parseEntity(entity);
    const resolved = await resolveEntity({
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        rawName: entity,
        aliases: [entity],
        source: 'query',
        createIfMissing: false,
    }).catch(() => ({
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        canonicalEntity: `${parsed.entityType}/${parsed.entityId}`,
        matchedBy: 'exact' as const,
        addedAliases: [] as string[],
    }));

    return {
        entityType: resolved.entityType,
        entityId: resolved.entityId,
        canonicalEntity: resolved.canonicalEntity,
    };
}

function isPersonalEntityString(entity: string): boolean {
    const [entityType] = entity.split('/', 1);
    const normalized = entityType?.trim().toLowerCase();
    return normalized === 'user' || normalized === 'person';
}

function mapArchiveResult(result: {
    valueRaw: unknown;
    valueSummary: string;
    confidence: number;
    source: string;
    validFrom: Date;
    validUntil: Date | null;
    archivedReason: ArchivedReason;
    resolutionState: ResolutionState;
    resolutionOutcome: ResolutionOutcome;
}): Omit<QueryResult, 'found' | 'resolvedEntity' | 'inputEntity'> {
    return {
        value: result.valueRaw,
        summary: result.valueSummary,
        confidence: result.confidence,
        source: result.source,
        validFrom: result.validFrom,
        validUntil: result.validUntil,
        contested: result.archivedReason === ArchivedReason.contradicted || result.archivedReason === ArchivedReason.escalated,
        fromArchive: true,
        archivedReason: result.archivedReason,
        resolutionState: result.resolutionState,
        resolutionOutcome: result.resolutionOutcome,
    };
}

// ─── Iranti Class ────────────────────────────────────────────────────────────

export class Iranti {
    private config: IrantiConfig;
    private sessionLedgerContext: SessionLedgerContext;

    constructor(config: IrantiConfig = {}) {
        this.config = config;
        this.sessionLedgerContext = {
            source: config.sessionLedgerSource?.trim() || undefined,
            host: typeof config.sessionLedgerHost === 'string'
                ? (config.sessionLedgerHost.trim() || null)
                : (config.sessionLedgerHost ?? null),
        };

        const connectionString = config.connectionString ?? process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('connectionString is required. Provide it in config or set DATABASE_URL environment variable.');
        }

        initDb(connectionString);

        if (config.llmProvider) {
            process.env.LLM_PROVIDER = config.llmProvider;
        }

        // Register the emitter once at construction time. All Staff components
        // read from the module-level registry — no threading required.
        // Do not downgrade an already-installed concrete emitter back to the
        // default no-op just because a later SDK consumer omitted the option.
        if (config.staffEventEmitter) {
            setStaffEventEmitter(config.staffEventEmitter);
        }
    }

    private buildSessionLedgerContext(): SessionLedgerContext | undefined {
        if (!this.sessionLedgerContext.source && !this.sessionLedgerContext.host) {
            return undefined;
        }
        return {
            source: this.sessionLedgerContext.source,
            host: this.sessionLedgerContext.host ?? null,
        };
    }

    // ── Write ───────────────────────────────────────────────────────────────

    async write(input: WriteInput): Promise<WriteResult> {
        if (input.confidence < 0 || input.confidence > 100) {
            throw new Error(`Confidence must be between 0 and 100. Got: ${input.confidence}`);
        }
        const { entityType, entityId } = parseEntity(input.entity);
        const resolved = await resolveEntity({
            entityType,
            entityId,
            rawName: input.entity,
            aliases: [input.entity],
            source: input.source,
            confidence: input.confidence,
            createIfMissing: true,
        });

        const result = await librarianWrite({
            entityType: resolved.entityType,
            entityId: resolved.entityId,
            key: input.key,
            valueRaw: input.value,
            valueSummary: input.summary,
            confidence: input.confidence,
            source: input.source,
            createdBy: input.agent,
            validFrom: input.validFrom,
            validUntil: input.validUntil ?? undefined,
            requestId: input.requestId,
            properties: input.properties,
        });

        return {
            action: result.action,
            key: input.key,
            reason: result.reason,
            resolvedEntity: resolved.canonicalEntity,
            inputEntity: input.entity,
        };
    }

    // ── Ingest ──────────────────────────────────────────────────────────────

    async ingest(input: IngestInput): Promise<IngestResult> {
        const { entityType, entityId } = parseEntity(input.entity);

        const result = await librarianIngest({
            entityType,
            entityId,
            rawContent: input.content,
            source: input.source,
            confidence: input.confidence,
            createdBy: input.agent,
        });

        return {
            extractedCandidates: result.extractedCandidates,
            written: result.written,
            rejected: result.rejected,
            escalated: result.escalated,
            skippedMalformed: result.skippedMalformed,
            reason: result.reason,
            facts: result.results.map((r) => ({
                action: r.action as IngestFactResult['action'],
                key: r.key,
                reason: r.reason,
            })),
        };
    }

    // ── Handshake ───────────────────────────────────────────────────────────

    async handshake(input: HandshakeInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(resolveAgentId(input, 'handshake'));
        return attendant.handshake({
            task: input.task,
            recentMessages: input.recentMessages,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    // ── Reconvene ───────────────────────────────────────────────────────────

    async reconvene(
        agentId: string,
        input: Omit<HandshakeInput, 'agent' | 'agentId'>
    ): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(agentId);
        return attendant.reconvene({
            task: input.task,
            recentMessages: input.recentMessages,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async checkpoint(input: SessionCheckpointInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(resolveAgentId(input, 'checkpoint'));
        return attendant.checkpoint({
            task: input.task,
            recentMessages: input.recentMessages,
            checkpoint: input.checkpoint,
            sessionId: input.sessionId,
            heartbeatAt: input.heartbeatAt,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async resumeSession(input: SessionActionInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(resolveAgentId(input, 'resumeSession'));
        return attendant.resumeSession({
            sessionId: input.sessionId,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async completeSession(input: SessionActionInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(resolveAgentId(input, 'completeSession'));
        return attendant.completeSession({
            sessionId: input.sessionId,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async abandonSession(input: SessionActionInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(resolveAgentId(input, 'abandonSession'));
        return attendant.abandonSession({
            sessionId: input.sessionId,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async inspectSession(input: SessionInspectionInput): Promise<SessionInspection> {
        const attendant = getAttendant(resolveAgentId(input, 'inspectSession'));
        return attendant.inspectSession({
            task: input.task,
            recentMessages: input.recentMessages,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async listSessions(input: SessionListInput = {}): Promise<SessionSummary[]> {
        const states = await listAttendantStateEntries(
            input.agentId?.trim() ? { agentId: input.agentId.trim() } : undefined,
        );
        let sessions = states
            .map((entry) => {
                const raw = entry.valueRaw as Partial<WorkingMemoryBrief> | null;
                const checkpoint = raw?.sessionCheckpoint ?? null;
                if (!checkpoint) return null;
                return summarizeSessionState(
                    entry.entityId,
                    checkpoint,
                    typeof raw?.briefGeneratedAt === 'string' ? raw.briefGeneratedAt : undefined,
                );
            })
            .filter((entry): entry is SessionSummary => Boolean(entry));

        if (input.operatorState) {
            sessions = sessions.filter((entry) => entry.operatorState === input.operatorState);
        }
        if (input.staleOnly) {
            sessions = sessions.filter((entry) => entry.isStale);
        }

        sessions.sort((a, b) => compareSessionSummaries(a, b, input.sort ?? 'operator'));

        if (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0) {
            sessions = sessions.slice(0, Math.floor(input.limit));
        }

        return sessions;
    }

    async listSessionLedger(input: SessionLedgerInput = {}): Promise<SessionLedgerEvent[]> {
        return querySessionLedger(input);
    }

    getAttendant(agentId: string): AttendantInstance {
        return getAttendant(agentId);
    }

    // ── Query ───────────────────────────────────────────────────────────────

    async query(entity: string, key: string, options: TemporalQueryOptions = {}): Promise<QueryResult> {
        const resolved = await resolveQueryEntity(entity);
        const personalRecallCandidates = (
            isPersonalEntityString(entity) && isPersonalMemoryKey(key)
                ? getPersonalRecallEntities(entity)
                : []
        )
            .filter((candidate) => candidate !== resolved.canonicalEntity);

        if (options.asOf) {
            const current = await findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key });
            const currentMatches = current && !current.isProtected && current.validFrom <= options.asOf;

            if (currentMatches) {
                await recordKnowledgeEntryAccess([current.id]);
                return {
                    found: true,
                    value: current.valueRaw,
                    summary: current.valueSummary,
                    confidence: current.confidence,
                    source: current.source,
                    validFrom: current.validFrom,
                    validUntil: current.validUntil,
                    contested: false,
                    fromArchive: false,
                    archivedReason: null,
                    resolutionState: null,
                    resolutionOutcome: null,
                    resolvedEntity: resolved.canonicalEntity,
                    inputEntity: entity,
                };
            }

            const historical = await findArchiveAsOf(
                { entityType: resolved.entityType, entityId: resolved.entityId, key },
                options.asOf,
                {
                    includeExpired: options.includeExpired,
                    includeContested: options.includeContested,
                }
            );

            if (historical) {
                return {
                    found: true,
                    ...mapArchiveResult(historical),
                    resolvedEntity: resolved.canonicalEntity,
                    inputEntity: entity,
                };
            }

            return { found: false, resolvedEntity: resolved.canonicalEntity, inputEntity: entity };
        }

        const primaryEntry = await findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key });
        let entry = primaryEntry;
        let resolvedEntity = resolved.canonicalEntity;

        if ((!entry || entry.isProtected) && personalRecallCandidates.length > 0) {
            for (const candidate of personalRecallCandidates) {
                const fallback = await resolveQueryEntity(candidate);
                const fallbackEntry = await findEntry({ entityType: fallback.entityType, entityId: fallback.entityId, key });
                if (fallbackEntry && !fallbackEntry.isProtected) {
                    entry = fallbackEntry;
                    resolvedEntity = fallback.canonicalEntity;
                    break;
                }
            }
        }

        if (!entry || entry.isProtected) {
            return { found: false, resolvedEntity, inputEntity: entity };
        }

        await recordKnowledgeEntryAccess([entry.id]);
        return {
            found: true,
            value: entry.valueRaw,
            summary: entry.valueSummary,
            confidence: entry.confidence,
            source: entry.source,
            validFrom: entry.validFrom,
            validUntil: entry.validUntil,
            contested: false,
            fromArchive: false,
            archivedReason: null,
            resolutionState: null,
            resolutionOutcome: null,
            resolvedEntity,
            inputEntity: entity,
        };
    }

    async history(entity: string, key: string, options: Omit<TemporalQueryOptions, 'asOf'> = {}): Promise<HistoryEntry[]> {
        const resolved = await resolveQueryEntity(entity);
        const [archiveRows, current] = await Promise.all([
            findArchiveHistory(
                { entityType: resolved.entityType, entityId: resolved.entityId, key },
                {
                    includeExpired: options.includeExpired,
                    includeContested: options.includeContested,
                }
            ),
            findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key }),
        ]);

        const history: HistoryEntry[] = archiveRows.map((row: {
            valueRaw: unknown;
            valueSummary: string;
            confidence: number;
            source: string;
            validFrom: Date;
            validUntil: Date | null;
            archivedReason: ArchivedReason;
            resolutionState: ResolutionState;
            resolutionOutcome: ResolutionOutcome;
        }) => ({
            value: row.valueRaw,
            summary: row.valueSummary,
            confidence: row.confidence,
            source: row.source,
            validFrom: row.validFrom,
            validUntil: row.validUntil,
            isCurrent: false,
            contested: row.archivedReason === ArchivedReason.contradicted || row.archivedReason === ArchivedReason.escalated,
            archivedReason: row.archivedReason,
            resolutionState: row.resolutionState,
            resolutionOutcome: row.resolutionOutcome,
        }));

        if (current && !current.isProtected) {
            history.push({
                value: current.valueRaw,
                summary: current.valueSummary,
                confidence: current.confidence,
                source: current.source,
                validFrom: current.validFrom,
                validUntil: current.validUntil,
                isCurrent: true,
                contested: false,
                archivedReason: null,
                resolutionState: null,
                resolutionOutcome: null,
            });
        }

        return history.sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
    }

    // ── Query All ───────────────────────────────────────────────────────────

    async queryAll(entity: string): Promise<Array<{
        key: string;
        value: unknown;
        summary: string;
        confidence: number;
        source: string;
    }>> {
        const resolved = await resolveQueryEntity(entity);

        const entries = await findEntriesByEntity(resolved.entityType, resolved.entityId);
        const visibleEntries = entries.filter((e) => !e.isProtected);
        await recordKnowledgeEntryAccess(visibleEntries.map((entry) => entry.id));

        return visibleEntries
            .map((e) => ({
            key: e.key,
            value: e.valueRaw,
            summary: e.valueSummary,
            confidence: e.confidence,
            source: e.source,
        }));
    }

    // ── Maintenance ─────────────────────────────────────────────────────────

    async search(input: HybridSearchInput): Promise<HybridSearchResult[]> {
        if (!input.query || typeof input.query !== 'string' || input.query.trim().length === 0) {
            throw new Error('query is required for search().');
        }

        const rows = await searchEntriesHybrid({
            query: input.query.trim(),
            limit: input.limit,
            entityType: input.entityType as EntityType | undefined,
            entityId: input.entityId,
            lexicalWeight: input.lexicalWeight,
            vectorWeight: input.vectorWeight,
            minScore: input.minScore,
        });

        return rows.map((row) => ({
            id: row.id,
            entity: `${row.entityType}/${row.entityId}`,
            key: row.key,
            value: row.valueRaw,
            summary: row.valueSummary,
            confidence: row.confidence,
            source: row.source,
            validUntil: row.validUntil,
            lexicalScore: row.lexicalScore,
            vectorScore: row.vectorScore,
            score: row.score,
        }));
    }
    async runMaintenance(): Promise<{
        expiredArchived: number;
        lowConfidenceArchived: number;
        escalationsProcessed: number;
        errors: string[];
    }> {
        return runArchivist();
    }

    // ── Relationships ───────────────────────────────────────────────────────

    async relate(
        fromEntity: string,
        relationshipType: string,
        toEntity: string,
        options: { createdBy: string; properties?: Record<string, unknown> } = { createdBy: 'sdk' }
    ): Promise<void> {
        const from = parseEntity(fromEntity);
        const to = parseEntity(toEntity);

        await createRelationship({
            fromType: from.entityType,
            fromId: from.entityId,
            relationshipType,
            toType: to.entityType,
            toId: to.entityId,
            createdBy: options.createdBy,
            properties: options.properties,
        });
    }

    async getRelated(entity: string): Promise<RelatedEntity[]> {
        const { entityType, entityId } = parseEntity(entity);
        return getRelated(entityType, entityId);
    }

    async getRelatedDeep(entity: string, depth: number = 2): Promise<RelatedEntity[]> {
        const { entityType, entityId } = parseEntity(entity);
        return getRelatedDeep(entityType, entityId, depth);
    }

    // ── Agent Registry ──────────────────────────────────────────────────────

    async registerAgent(profile: AgentProfile): Promise<void> {
        return registerAgent(profile);
    }

    async getAgent(agentId: string): Promise<AgentRecord | null> {
        return getAgent(agentId);
    }

    async whoKnows(entity: string): Promise<Array<{
        agentId: string;
        keys: string[];
        totalContributions: number;
    }>> {
        const { entityType, entityId } = parseEntity(entity);
        return whoKnows(entityType, entityId);
    }

    async listAgents(): Promise<AgentProfile[]> {
        return listAgents();
    }

    async assignToTeam(agentId: string, teamId: string): Promise<void> {
        return assignToTeam(agentId, teamId, 'sdk');
    }

    // ── Context Window Observation ────────────────────────────────────────────

    async observe(input: ObserveInput): Promise<import('../attendant/AttendantInstance').ObserveResult> {
        const agentId = resolveAgentId(input, 'observe');

        if (input.entityHints !== undefined) {
            if (!Array.isArray(input.entityHints)) {
                throw new Error('entityHints must be an array of "entityType/entityId" strings.');
            }
            for (const hint of input.entityHints) {
                if (typeof hint !== 'string' || hint.trim().length === 0 || !hint.includes('/')) {
                    throw new Error(`Invalid entity hint: "${String(hint)}". Expected "entityType/entityId".`);
                }
                parseEntity(hint);
            }
        }

        const attendant = getAttendant(agentId);
        return attendant.observe({
            currentContext: input.currentContext,
            maxFacts: input.maxFacts,
            entityHints: input.entityHints,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    async attend(input: AttendInput): Promise<AttendResult> {
        const agentId = resolveAgentId(input, 'attend');

        if (input.entityHints !== undefined) {
            if (!Array.isArray(input.entityHints)) {
                throw new Error('entityHints must be an array of "entityType/entityId" strings.');
            }
            for (const hint of input.entityHints) {
                if (typeof hint !== 'string' || hint.trim().length === 0 || !hint.includes('/')) {
                    throw new Error(`Invalid entity hint: "${String(hint)}". Expected "entityType/entityId".`);
                }
                parseEntity(hint);
            }
        }

        const attendant = getAttendant(agentId);
        return attendant.attend({
            currentContext: input.currentContext,
            maxFacts: input.maxFacts,
            entityHints: input.entityHints,
            latestMessage: input.latestMessage,
            forceInject: input.forceInject,
            suppressEvents: input.suppressEvents,
            ledgerContext: this.buildSessionLedgerContext(),
        });
    }

    // ── Mock Configuration (dev/test only) ──────────────────────────────────

    configureMock(config: Partial<MockConfig>): void {
        if (process.env.LLM_PROVIDER !== 'mock') {
            console.warn('[iranti] configureMock() called but LLM_PROVIDER is not mock. No effect.');
            return;
        }
        configureMock(config);
    }
}

// ─── Default Export ──────────────────────────────────────────────────────────

export default Iranti;

// ─── Public re-exports for observability consumers ─────────────────────────────────────────────
// Consumers who build their own emitter (e.g., a DbStaffEventEmitter) need
// the interface, the noop default, and the registry setter.

export type { IStaffEventEmitter, StaffEventInput, StaffEvent };
export { NoopEventEmitter, buildStaffEvent };
export { setStaffEventEmitter, getStaffEventEmitter, resetStaffEventEmitter };
