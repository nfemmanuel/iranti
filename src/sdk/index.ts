import 'dotenv/config';
import { initDb } from '../library/client';
import { librarianWrite, librarianIngest } from '../librarian';
import type { WorkingMemoryBrief, AttendResult } from '../attendant';
import { getAttendant, AttendantInstance } from '../attendant/registry';
import { runArchivist } from '../archivist';
import { findArchiveAsOf, findArchiveHistory, findEntriesByEntity, findEntry, recordKnowledgeEntryAccess, searchEntriesHybrid } from '../library/queries';
import { createRelationship, getRelated, getRelatedDeep, RelatedEntity } from '../library/relationships';
import { registerAgent, getAgent, whoKnows, listAgents, assignToTeam, AgentProfile, AgentRecord } from '../library/agent-registry';
import { resolveEntity } from '../library/entity-resolution';
import { configureMock, MockConfig } from '../lib/providers/mock';
import { EntityType } from '../types';
import { ArchivedReason, ResolutionOutcome, ResolutionState } from '../generated/prisma/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IrantiConfig {
    connectionString?: string;
    llmProvider?: string;
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
}

export interface IngestInput {
    entity: string;
    content: string;
    source: string;
    confidence: number;
    agent: string;
}

export interface HandshakeInput {
    agent: string;
    task: string;
    recentMessages: string[];
}

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

export interface IngestResult {
    written: number;
    rejected: number;
    escalated: number;
    facts: WriteResult[];
}

export interface ObserveInput {
    agent: string;
    currentContext: string;
    maxFacts?: number;
    entityHints?: string[];
}

export interface AttendInput extends ObserveInput {
    latestMessage?: string;
    forceInject?: boolean;
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

    constructor(config: IrantiConfig = {}) {
        this.config = config;

        const connectionString = config.connectionString ?? process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('connectionString is required. Provide it in config or set DATABASE_URL environment variable.');
        }

        initDb(connectionString);

        if (config.llmProvider) {
            process.env.LLM_PROVIDER = config.llmProvider;
        }
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
            written: result.written,
            rejected: result.rejected,
            escalated: result.escalated,
            facts: result.results.map((r) => ({
                action: r.action as WriteResult['action'],
                key: r.key,
                reason: r.reason,
            })),
        };
    }

    // ── Handshake ───────────────────────────────────────────────────────────

    async handshake(input: HandshakeInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(input.agent);
        return attendant.handshake({
            task: input.task,
            recentMessages: input.recentMessages,
        });
    }

    // ── Reconvene ───────────────────────────────────────────────────────────

    async reconvene(
        agentId: string,
        input: Omit<HandshakeInput, 'agent'>
    ): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(agentId);
        return attendant.reconvene({
            task: input.task,
            recentMessages: input.recentMessages,
        });
    }

    getAttendant(agentId: string): AttendantInstance {
        return getAttendant(agentId);
    }

    // ── Query ───────────────────────────────────────────────────────────────

    async query(entity: string, key: string, options: TemporalQueryOptions = {}): Promise<QueryResult> {
        const resolved = await resolveQueryEntity(entity);

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

        const entry = await findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key });
        if (!entry || entry.isProtected) {
            return { found: false, resolvedEntity: resolved.canonicalEntity, inputEntity: entity };
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
            resolvedEntity: resolved.canonicalEntity,
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

        const history: HistoryEntry[] = archiveRows.map((row) => ({
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
        if (!input.agent || typeof input.agent !== 'string' || input.agent.trim().length === 0) {
            throw new Error('agent is required for observe().');
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

        const attendant = getAttendant(input.agent);
        return attendant.observe({
            currentContext: input.currentContext,
            maxFacts: input.maxFacts,
            entityHints: input.entityHints,
        });
    }

    async attend(input: AttendInput): Promise<AttendResult> {
        if (!input.agent || typeof input.agent !== 'string' || input.agent.trim().length === 0) {
            throw new Error('agent is required for attend().');
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

        const attendant = getAttendant(input.agent);
        return attendant.attend({
            currentContext: input.currentContext,
            maxFacts: input.maxFacts,
            entityHints: input.entityHints,
            latestMessage: input.latestMessage,
            forceInject: input.forceInject,
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
