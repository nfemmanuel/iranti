import 'dotenv/config';
import { librarianWrite, librarianIngest } from '../librarian';
import { WorkingMemoryBrief } from '../attendant';
import { getAttendant, AttendantInstance } from '../attendant/registry';
import { runArchivist } from '../archivist';
import { queryEntry, findEntriesByEntity } from '../library/queries';
import { createRelationship, getRelated, getRelatedDeep, RelatedEntity } from '../library/relationships';
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
}

export interface WriteResult {
    action: 'created' | 'updated' | 'escalated' | 'rejected';
    key: string;
    reason: string;
}

export interface IngestResult {
    written: number;
    rejected: number;
    escalated: number;
    facts: WriteResult[];
}

// ─── Entity Parsing ──────────────────────────────────────────────────────────

function parseEntity(entity: string): { entityType: EntityType; entityId: string } {
    const parts = entity.split('/');
    if (parts.length < 2) {
        throw new Error(
            `Invalid entity format: "${entity}". Expected "entityType/entityId" e.g. "researcher/jane_smith"`
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

        if (config.connectionString) {
            process.env.DATABASE_URL = config.connectionString;
        }

        if (config.llmProvider) {
            process.env.LLM_PROVIDER = config.llmProvider;
        }
    }

    // ── Write ───────────────────────────────────────────────────────────────

    async write(input: WriteInput): Promise<WriteResult> {
        const { entityType, entityId } = parseEntity(input.entity);

        const result = await librarianWrite({
            entityType,
            entityId,
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
        const { entityType, entityId } = parseEntity(entity);

        const result = await queryEntry({ entityType, entityId, key });

        if (!result.found || !result.entry) {
            return { found: false };
        }

        return {
            found: true,
            value: result.entry.valueRaw,
            summary: result.entry.valueSummary,
            confidence: result.entry.confidence,
            source: result.entry.source,
            validUntil: result.entry.validUntil,
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
        const { entityType, entityId } = parseEntity(entity);

        const entries = await findEntriesByEntity(entityType, entityId);

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
}

// ─── Default Export ──────────────────────────────────────────────────────────

export default Iranti;
