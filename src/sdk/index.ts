import 'dotenv/config';
import { initDb } from '../library/client';
import { librarianWrite, librarianIngest } from '../librarian';
import { WorkingMemoryBrief } from '../attendant';
import { getAttendant, AttendantInstance } from '../attendant/registry';
import { runArchivist } from '../archivist';
import { queryEntry, findEntriesByEntity, findEntry } from '../library/queries';
import { createRelationship, getRelated, getRelatedDeep, RelatedEntity } from '../library/relationships';
import { registerAgent, getAgent, whoKnows, listAgents, assignToTeam, AgentProfile, AgentRecord } from '../library/agent-registry';
import { resolveEntity } from '../library/entity-resolution';
import { configureMock, MockConfig } from '../lib/providers/mock';
import { EntityType } from '../types';

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
    validUntil?: Date;
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

export interface QueryResult {
    found: boolean;
    value?: unknown;
    summary?: string;
    confidence?: number;
    source?: string;
    validUntil?: Date | null;
    resolvedEntity?: string;
    inputEntity?: string;
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
            validUntil: input.validUntil,
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

    async query(entity: string, key: string): Promise<QueryResult> {
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

        const entry = await findEntry({ entityType: resolved.entityType, entityId: resolved.entityId, key });

        if (!entry) {
            return { found: false, resolvedEntity: resolved.canonicalEntity, inputEntity: entity };
        }

        // Check if entry has escalated conflicts in its log
        if (entry.conflictLog) {
            const log = Array.isArray(entry.conflictLog) ? entry.conflictLog : [];
            const hasEscalation = log.some((event: any) => event.type === 'CONFLICT_ESCALATED');
            if (hasEscalation) {
                return { found: false, resolvedEntity: resolved.canonicalEntity, inputEntity: entity }; // Treat escalated entries as not found
            }
        }

        return {
            found: true,
            value: entry.valueRaw,
            summary: entry.valueSummary,
            confidence: entry.confidence,
            source: entry.source,
            validUntil: entry.validUntil,
            resolvedEntity: resolved.canonicalEntity,
            inputEntity: entity,
        };
    }

    // ── Query All ───────────────────────────────────────────────────────────

    async queryAll(entity: string): Promise<Array<{
        key: string;
        value: unknown;
        summary: string;
        confidence: number;
        source: string;
    }>> {
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

        const entries = await findEntriesByEntity(resolved.entityType, resolved.entityId);

        return entries.map((e) => ({
            key: e.key,
            value: e.valueRaw,
            summary: e.valueSummary,
            confidence: e.confidence,
            source: e.source,
        }));
    }

    // ── Maintenance ─────────────────────────────────────────────────────────

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
