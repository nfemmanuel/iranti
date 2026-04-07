import 'dotenv/config';
import { getDb, initDb } from '../library/client';
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
    SessionComplianceState,
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
import { buildIssueFactWrite, IssueFactInput, IssueSeverity, IssueStatus } from '../lib/issueFacts';
import { configureMock, MockConfig } from '../lib/providers/mock';
import { AgentProtocolTracker, ProtocolEnforcementMode, ProtocolOperation, ProtocolViolation, ProtocolViolationError } from '../lib/protocolEnforcement';
import { EntityType } from '../types';
import { ArchivedReason, ResolutionOutcome, ResolutionState } from '../generated/prisma/client';
import { querySessionLedger, SessionLedgerEvent, SessionLedgerQuery } from '../lib/sessionLedger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IrantiConfig {
    connectionString?: string;
    llmProvider?: string;
    sessionLedgerSource?: string;
    sessionLedgerHost?: string | null;
    sessionLedgerAgentId?: string;
    dbApplicationName?: string;
    dbPoolMax?: number;
    protocolEnforcement?: ProtocolEnforcementMode;
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

export type { IssueStatus, IssueSeverity };

export interface WriteIssueInput extends Omit<IssueFactInput, 'severity' | 'status'> {
    status: IssueStatus;
    severity?: IssueSeverity;
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
    postCompaction?: boolean;
}

export type SessionStatus = 'active' | 'interrupted' | 'completed' | 'abandoned';

export interface SessionCheckpointPayload {
    currentStep?: string;
    nextStep?: string;
    openRisks?: string[];
    recentOutputs?: string[];
    actions?: Array<{
        kind: string;
        summary: string;
        status?: string;
        target?: string;
        detail?: string;
    }>;
    fileChanges?: Array<{
        action: string;
        path: string;
        toPath?: string;
        purpose?: string;
    }>;
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
    compliance: SessionComplianceState;
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

export type { ProtocolEnforcementMode, ProtocolViolation };
export { ProtocolViolationError };

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
    phase?: 'pre-response' | 'post-response' | 'mid-turn';
}

type SessionLedgerContext = {
    source?: string;
    host?: string | null;
    agentId?: string;
};

function normalizeDbApplicationToken(value?: string | null): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || undefined;
}

function deriveDbApplicationName(config: IrantiConfig): string | undefined {
    const explicit = normalizeDbApplicationToken(config.dbApplicationName);
    if (explicit) {
        return explicit.slice(0, 63);
    }

    const source = normalizeDbApplicationToken(config.sessionLedgerSource);
    const host = normalizeDbApplicationToken(config.sessionLedgerHost);
    const agentId = normalizeDbApplicationToken(config.sessionLedgerAgentId);
    const parts = ['iranti', source, host ?? agentId].filter((part): part is string => Boolean(part));

    if (parts.length === 1) {
        return undefined;
    }

    return parts.join(':').slice(0, 63);
}
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
    private readonly protocolTracker: AgentProtocolTracker;

    constructor(config: IrantiConfig = {}) {
        this.config = config;
        this.protocolTracker = new AgentProtocolTracker();
        this.sessionLedgerContext = {
            source: config.sessionLedgerSource?.trim() || undefined,
            host: typeof config.sessionLedgerHost === 'string'
                ? (config.sessionLedgerHost.trim() || null)
                : (config.sessionLedgerHost ?? null),
            agentId: config.sessionLedgerAgentId?.trim() || undefined,
        };

        const connectionString = config.connectionString ?? process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('connectionString is required. Provide it in config or set DATABASE_URL environment variable.');
        }

        initDb(connectionString, {
            applicationName: deriveDbApplicationName(config),
            max: config.dbPoolMax,
        });

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

    private protocolMode(): ProtocolEnforcementMode {
        return this.config.protocolEnforcement ?? 'off';
    }

    private protocolAgentId(): string | undefined {
        return this.sessionLedgerContext.agentId?.trim() || undefined;
    }

    private checkProtocol(operation: ProtocolOperation, requirements: {
        handshake?: boolean;
        attend?: boolean;
        postResponse?: boolean;
    }): void {
        const mode = this.protocolMode();
        if (mode === 'off') return;
        const agentId = this.protocolAgentId();
        if (!agentId) return;

        const violation = this.protocolTracker.check(agentId, operation, requirements);
        if (!violation) return;
        if (mode === 'warn') {
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'host_failure',
                agentId,
                source: 'sdk',
                reason: violation.code,
                level: 'audit',
                metadata: {
                    operation,
                    protocolViolation: violation,
                },
            });
            return;
        }
        throw new ProtocolViolationError(violation);
    }

    private syncMemoryUseCompliance(agentId: string, compliance?: SessionComplianceState | null): void {
        const ignoredMemoryIssue = compliance?.issues.find((issue) => issue.code === 'ignored_injected_memory');
        if (ignoredMemoryIssue?.severity === 'error') {
            this.protocolTracker.markMemoryUseAcknowledgementRequired(agentId);
            return;
        }
        this.protocolTracker.clearMemoryUseAcknowledgementRequired(agentId);
    }

    private consumeDiscoveryBudget(operation: ProtocolOperation): void {
        if (this.protocolMode() === 'off') return;
        const agentId = this.protocolAgentId();
        if (!agentId) return;
        if (['query', 'history', 'queryAll', 'search', 'related', 'related_deep', 'who_knows'].includes(operation)) {
            this.protocolTracker.notifyDiscoveryConsumed(agentId);
        }
    }

    setSessionLedgerContext(context: {
        source?: string | null;
        host?: string | null;
        agentId?: string | null;
    }): void {
        if ('source' in context) {
            this.sessionLedgerContext.source = typeof context.source === 'string'
                ? (context.source.trim() || undefined)
                : undefined;
        }
        if ('host' in context) {
            this.sessionLedgerContext.host = typeof context.host === 'string'
                ? (context.host.trim() || null)
                : (context.host ?? null);
        }
        if ('agentId' in context) {
            this.sessionLedgerContext.agentId = typeof context.agentId === 'string'
                ? (context.agentId.trim() || undefined)
                : undefined;
        }
    }

    async loadProtocolStateFromLedger(agentId: string, options: {
        handshakeTtlMs?: number;
        attendTtlMs?: number;
    } = {}): Promise<{ handshakeRestored: boolean; attendRestored: boolean }> {
        const handshakeTtl = options.handshakeTtlMs ?? 10 * 60 * 1000;
        const attendTtl = options.attendTtlMs ?? 3 * 60 * 1000;
        const now = Date.now();
        try {
            // Read from the synchronously-written attendant_state knowledge entry
            // rather than the fire-and-forget session ledger, to avoid a race
            // condition where the DB write hasn't landed before process exit.
            const row = await getDb().knowledgeEntry.findUnique({
                where: { entityType_entityId_key: { entityType: 'agent', entityId: agentId, key: 'attendant_state' } },
                select: { valueRaw: true, updatedAt: true },
            });
            if (!row) return { handshakeRestored: false, attendRestored: false };

            const brief = row.valueRaw as WorkingMemoryBrief | null;
            if (!brief?.sessionStarted) return { handshakeRestored: false, attendRestored: false };

            const sessionStartedAt = new Date(brief.sessionStarted).getTime();
            // Use briefGeneratedAt (last activity time) for TTL, not sessionStarted (session creation time).
            // Sessions are persistent and can be days old; briefGeneratedAt is updated on every handshake/attend.
            const briefGeneratedAt = new Date(brief.briefGeneratedAt).getTime();
            if (isNaN(sessionStartedAt) || isNaN(briefGeneratedAt) || now - briefGeneratedAt > handshakeTtl) {
                return { handshakeRestored: false, attendRestored: false };
            }

            const complianceUpdatedAt = brief.compliance?.lastUpdated
                ? new Date(brief.compliance.lastUpdated).getTime()
                : NaN;
            const lastAttendTime = !isNaN(complianceUpdatedAt) ? Math.max(briefGeneratedAt, complianceUpdatedAt) : briefGeneratedAt;
            const lastAttendPhaseRaw = brief.compliance?.counters.lastAttendPhase;
            const lastAttendPhase: 'pre-response' | 'post-response' | 'mid-turn' =
                (lastAttendPhaseRaw === 'pre-response' || lastAttendPhaseRaw === 'post-response' || lastAttendPhaseRaw === 'mid-turn')
                    ? lastAttendPhaseRaw : 'pre-response';

            const attendRestored = !isNaN(lastAttendTime)
                && now - lastAttendTime <= attendTtl
                && lastAttendTime > sessionStartedAt;

            this.protocolTracker.bootstrapState(agentId, {
                lastHandshakeAt: sessionStartedAt,
                ...(attendRestored && {
                    lastAttendAt: lastAttendTime,
                    lastAttendPhase,
                    discoveryBudget: lastAttendPhase !== 'post-response' ? 1 : 0,
                    pendingPostResponse: lastAttendPhase === 'pre-response' || lastAttendPhase === 'mid-turn',
                }),
            });

            return { handshakeRestored: true, attendRestored };
        } catch {
            return { handshakeRestored: false, attendRestored: false };
        }
    }

    private buildSessionLedgerContext(): SessionLedgerContext | undefined {
        if (!this.sessionLedgerContext.source && !this.sessionLedgerContext.host && !this.sessionLedgerContext.agentId) {
            return undefined;
        }
        return {
            source: this.sessionLedgerContext.source,
            host: this.sessionLedgerContext.host ?? null,
            agentId: this.sessionLedgerContext.agentId,
        };
    }

    private emitLedgerEvent(event: StaffEventInput): void {
        const context = this.buildSessionLedgerContext();
        const metadata = event.metadata && typeof event.metadata === 'object'
            ? { ...event.metadata }
            : {};
        if (context?.host) {
            metadata.host = context.host;
        }
        getStaffEventEmitter().emit({
            ...event,
            agentId: context?.agentId && (!event.agentId || event.agentId === 'sdk')
                ? context.agentId
                : event.agentId,
            source: context?.source ?? event.source,
            metadata,
        });
    }

    private async noteRediscoveryEvidence(): Promise<void> {
        const agentId = this.protocolAgentId();
        if (!agentId) return;
        await getAttendant(agentId).noteDiscoveryOccurred();
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

        await getAttendant(input.agent).notifyWriteOccurred();
        this.protocolTracker.clearMemoryUseAcknowledgementRequired(input.agent);
        return {
            action: result.action,
            key: input.key,
            reason: result.reason,
            resolvedEntity: resolved.canonicalEntity,
            inputEntity: input.entity,
        };
    }

    async writeIssue(input: WriteIssueInput): Promise<WriteResult> {
        return this.write(buildIssueFactWrite(input));
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
        await getAttendant(input.agent).notifyWriteOccurred();
        this.protocolTracker.clearMemoryUseAcknowledgementRequired(input.agent);

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
        const agentId = resolveAgentId(input, 'handshake');
        const attendant = getAttendant(agentId);
        const result = await attendant.handshake({
            task: input.task,
            recentMessages: input.recentMessages,
            postCompaction: input.postCompaction,
            ledgerContext: this.buildSessionLedgerContext(),
        });
        this.protocolTracker.markHandshake(agentId);
        this.syncMemoryUseCompliance(agentId, result.compliance);
        return result;
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
        const agentId = resolveAgentId(input, 'checkpoint');
        const attendant = getAttendant(agentId);
        const result = await attendant.checkpoint({
            task: input.task,
            recentMessages: input.recentMessages,
            checkpoint: input.checkpoint,
            sessionId: input.sessionId,
            heartbeatAt: input.heartbeatAt,
            ledgerContext: this.buildSessionLedgerContext(),
        });
        this.protocolTracker.clearMemoryUseAcknowledgementRequired(agentId);
        this.protocolTracker.clearPendingPostResponse(agentId);
        return result;
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
                    raw?.compliance ?? null,
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
        this.checkProtocol('query', { handshake: true, attend: true });
        const resolved = await resolveQueryEntity(entity);
        const personalRecallCandidates = (
            isPersonalEntityString(entity) && isPersonalMemoryKey(key)
                ? getPersonalRecallEntities(entity)
                : []
        )
            .filter((candidate) => candidate !== resolved.canonicalEntity);
        try {

            if (options.asOf) {
                const current = await findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key });
                const currentMatches = current && !current.isProtected && current.validFrom <= options.asOf;

                if (currentMatches) {
                    this.consumeDiscoveryBudget('query');
                    await recordKnowledgeEntryAccess([current.id]);
                    this.emitLedgerEvent({
                        staffComponent: 'Attendant',
                        actionType: 'query_executed',
                        agentId: 'sdk',
                        source: 'sdk',
                        entityType: resolved.entityType,
                        entityId: resolved.entityId,
                        key,
                        reason: 'query_exact_current',
                        level: 'audit',
                        metadata: {
                            found: true,
                            fromArchive: false,
                            asOf: options.asOf.toISOString(),
                        },
                    });
                    await this.noteRediscoveryEvidence();
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
                    this.consumeDiscoveryBudget('query');
                    this.emitLedgerEvent({
                        staffComponent: 'Attendant',
                        actionType: 'query_executed',
                        agentId: 'sdk',
                        source: 'sdk',
                        entityType: resolved.entityType,
                        entityId: resolved.entityId,
                        key,
                        reason: 'query_historical_match',
                        level: 'audit',
                        metadata: {
                            found: true,
                            fromArchive: true,
                            asOf: options.asOf.toISOString(),
                        },
                    });
                    await this.noteRediscoveryEvidence();
                    return {
                        found: true,
                        ...mapArchiveResult(historical),
                        resolvedEntity: resolved.canonicalEntity,
                        inputEntity: entity,
                    };
                }

                this.emitLedgerEvent({
                    staffComponent: 'Attendant',
                    actionType: 'query_executed',
                    agentId: 'sdk',
                    source: 'sdk',
                    entityType: resolved.entityType,
                    entityId: resolved.entityId,
                    key,
                    reason: 'query_historical_miss',
                    level: 'audit',
                    metadata: {
                        found: false,
                        fromArchive: true,
                        asOf: options.asOf.toISOString(),
                    },
                });
                await this.noteRediscoveryEvidence();
                return { found: false, resolvedEntity: resolved.canonicalEntity, inputEntity: entity };
            }

            const primaryEntry = await findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key });
            let entry = primaryEntry;
            const resolvedEntity = resolved.canonicalEntity;
            let usedFallback = false;

            if ((!entry || entry.isProtected) && personalRecallCandidates.length > 0) {
                for (const candidate of personalRecallCandidates) {
                    const fallback = await resolveQueryEntity(candidate);
                    const fallbackEntry = await findEntry({ entityType: fallback.entityType, entityId: fallback.entityId, key });
                    if (fallbackEntry && !fallbackEntry.isProtected) {
                        entry = fallbackEntry;
                        usedFallback = true;
                        break;
                    }
                }
            }

            if (!entry || entry.isProtected) {
                this.emitLedgerEvent({
                    staffComponent: 'Attendant',
                    actionType: 'query_executed',
                    agentId: 'sdk',
                    source: 'sdk',
                    entityType: resolved.entityType,
                    entityId: resolved.entityId,
                    key,
                    reason: personalRecallCandidates.length > 0 ? 'query_personal_fallback_miss' : 'query_exact_miss',
                    level: 'audit',
                    metadata: {
                        found: false,
                        resolvedEntity,
                        inputEntity: entity,
                    },
                });
                await this.noteRediscoveryEvidence();
                return { found: false, resolvedEntity, inputEntity: entity };
            }

            await recordKnowledgeEntryAccess([entry.id]);
            this.consumeDiscoveryBudget('query');
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'query_executed',
                agentId: 'sdk',
                source: 'sdk',
                entityType: entry.entityType,
                entityId: entry.entityId,
                key,
                reason: usedFallback ? 'query_personal_fallback_match' : 'query_exact_match',
                level: 'audit',
                metadata: {
                    found: true,
                    resolvedEntity,
                    inputEntity: entity,
                },
            });
            await this.noteRediscoveryEvidence();
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
        } catch (error) {
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'host_failure',
                agentId: 'sdk',
                source: 'sdk',
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key,
                reason: 'query_failed',
                level: 'audit',
                metadata: {
                    operation: 'query',
                    inputEntity: entity,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            throw error;
        }
    }

    async history(entity: string, key: string, options: Omit<TemporalQueryOptions, 'asOf'> = {}): Promise<HistoryEntry[]> {
        this.checkProtocol('history', { handshake: true, attend: true });
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

        this.consumeDiscoveryBudget('history');
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
        this.checkProtocol('queryAll', { handshake: true, attend: true });
        const resolved = await resolveQueryEntity(entity);

        const entries = await findEntriesByEntity(resolved.entityType, resolved.entityId);
        const visibleEntries = entries.filter((e) => !e.isProtected);
        await recordKnowledgeEntryAccess(visibleEntries.map((entry) => entry.id));
        this.consumeDiscoveryBudget('queryAll');
        await this.noteRediscoveryEvidence();

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
        this.checkProtocol('search', { handshake: true, attend: true });
        if (!input.query || typeof input.query !== 'string' || input.query.trim().length === 0) {
            throw new Error('query is required for search().');
        }
        try {
            const rows = await searchEntriesHybrid({
                query: input.query.trim(),
                limit: input.limit,
                entityType: input.entityType as EntityType | undefined,
                entityId: input.entityId,
                lexicalWeight: input.lexicalWeight,
                vectorWeight: input.vectorWeight,
                minScore: input.minScore,
            });

            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'search_executed',
                agentId: 'sdk',
                source: 'sdk',
                entityType: input.entityType,
                entityId: input.entityId,
                reason: 'hybrid_search',
                level: 'audit',
                metadata: {
                    queryPreview: input.query.trim().slice(0, 120),
                    resultCount: rows.length,
                    minScore: input.minScore ?? null,
                },
            });

            this.consumeDiscoveryBudget('search');
            await this.noteRediscoveryEvidence();
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
        } catch (error) {
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'host_failure',
                agentId: 'sdk',
                source: 'sdk',
                entityType: input.entityType,
                entityId: input.entityId,
                reason: 'search_failed',
                level: 'audit',
                metadata: {
                    operation: 'search',
                    queryPreview: input.query.trim().slice(0, 120),
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            throw error;
        }
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
        await getAttendant(options.createdBy).notifyWriteOccurred();
        this.protocolTracker.clearMemoryUseAcknowledgementRequired(options.createdBy);
    }

    async getRelated(entity: string): Promise<RelatedEntity[]> {
        this.checkProtocol('related', { handshake: true, attend: true });
        const { entityType, entityId } = parseEntity(entity);
        try {
            const result = await getRelated(entityType, entityId);
            this.consumeDiscoveryBudget('related');
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'related_executed',
                agentId: 'sdk',
                source: 'sdk',
                entityType,
                entityId,
                reason: 'relationship_lookup',
                level: 'audit',
                metadata: {
                    resultCount: result.length,
                },
            });
            await this.noteRediscoveryEvidence();
            return result;
        } catch (error) {
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'host_failure',
                agentId: 'sdk',
                source: 'sdk',
                entityType,
                entityId,
                reason: 'related_failed',
                level: 'audit',
                metadata: {
                    operation: 'related',
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            throw error;
        }
    }

    async getRelatedDeep(entity: string, depth: number = 2): Promise<RelatedEntity[]> {
        this.checkProtocol('related_deep', { handshake: true, attend: true });
        const { entityType, entityId } = parseEntity(entity);
        try {
            const result = await getRelatedDeep(entityType, entityId, depth);
            this.consumeDiscoveryBudget('related_deep');
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'related_deep_executed',
                agentId: 'sdk',
                source: 'sdk',
                entityType,
                entityId,
                reason: 'relationship_lookup_deep',
                level: 'audit',
                metadata: {
                    resultCount: result.length,
                    depth,
                },
            });
            await this.noteRediscoveryEvidence();
            return result;
        } catch (error) {
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'host_failure',
                agentId: 'sdk',
                source: 'sdk',
                entityType,
                entityId,
                reason: 'related_deep_failed',
                level: 'audit',
                metadata: {
                    operation: 'related_deep',
                    depth,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            throw error;
        }
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
        this.checkProtocol('who_knows', { handshake: true, attend: true });
        const { entityType, entityId } = parseEntity(entity);
        try {
            const result = await whoKnows(entityType, entityId);
            this.consumeDiscoveryBudget('who_knows');
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'whoknows_executed',
                agentId: 'sdk',
                source: 'sdk',
                entityType,
                entityId,
                reason: 'agent_contribution_lookup',
                level: 'audit',
                metadata: {
                    resultCount: result.length,
                },
            });
            await this.noteRediscoveryEvidence();
            return result;
        } catch (error) {
            this.emitLedgerEvent({
                staffComponent: 'Attendant',
                actionType: 'host_failure',
                agentId: 'sdk',
                source: 'sdk',
                entityType,
                entityId,
                reason: 'whoknows_failed',
                level: 'audit',
                metadata: {
                    operation: 'whoknows',
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            throw error;
        }
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
        this.checkProtocol('observe', { handshake: true });

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
        if (input.phase === 'pre-response') {
            this.checkProtocol('attend', { postResponse: true });
        }

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
        const result = await attendant.attend({
            currentContext: input.currentContext,
            maxFacts: input.maxFacts,
            entityHints: input.entityHints,
            latestMessage: input.latestMessage,
            forceInject: input.forceInject,
            suppressEvents: input.suppressEvents,
            phase: input.phase,
            ledgerContext: this.buildSessionLedgerContext(),
        });
        if (result.bootstrap?.handshakePerformed) {
            this.protocolTracker.markHandshake(agentId);
        }
        this.protocolTracker.markAttend(agentId, input.phase);
        if (input.phase === 'post-response') {
            this.syncMemoryUseCompliance(agentId, result.compliance);
        }
        return result;
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

