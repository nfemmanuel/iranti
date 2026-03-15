import { getDb } from './client';
import {
    EntryInput,
    EntryQuery,
    HybridSearchInput,
    HybridSearchResult,
    QueryResult,
} from '../types';
import {
    Archive,
    ArchivedReason,
    KnowledgeEntry,
    Prisma,
    PrismaClient,
    ResolutionOutcome,
    ResolutionState,
} from '../generated/prisma/client';
import { buildEmbeddingText, generateEmbedding } from './embeddings';
import { getScore, getReliabilityScores } from '../librarian/source-reliability';
import { getDecayConfig, initialStabilityFromReliability, readOriginalConfidence } from '../lib/decay';
import { createVectorBackend } from './backends';
import { VectorBackend } from './vectorBackend';

type DbClient = PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

type HybridSearchRow = {
    id: number;
    entityType: string;
    entityId: string;
    key: string;
    valueRaw: unknown;
    valueSummary: string;
    confidence: number;
    source: string;
    validUntil: Date | null;
    lexicalScore: number | string | null;
    vectorScore: number | string | null;
    score: number | string;
};

export type ArchiveHistoryEntry = Archive;

type SupersededByPointer = {
    entityType: string;
    entityId: string;
    key: string;
};

export type TemporalArchiveOptions = {
    reason: ArchivedReason;
    validFrom?: Date;
    validUntil?: Date | null;
    resolutionState?: ResolutionState;
    resolutionOutcome?: ResolutionOutcome;
    supersededBy?: SupersededByPointer;
};

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_LEXICAL_WEIGHT = 0.45;
const DEFAULT_VECTOR_WEIGHT = 0.55;
const DEFAULT_MIN_SCORE = 0;

let vectorBackend: VectorBackend | null = null;

function coerceScore(value: number | string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getVectorBackendSingleton(): VectorBackend {
    if (!vectorBackend) {
        vectorBackend = createVectorBackend();
    }
    return vectorBackend;
}

async function saveEmbedding(entryId: number, text: string): Promise<void> {
    await getVectorBackendSingleton().upsert({
        id: String(entryId),
        vector: generateEmbedding(text),
        metadata: { id: entryId },
    });
}

function defaultResolutionState(reason: ArchivedReason): ResolutionState {
    return reason === ArchivedReason.escalated ? ResolutionState.pending : ResolutionState.not_applicable;
}

function defaultResolutionOutcome(reason: ArchivedReason): ResolutionOutcome {
    return reason === ArchivedReason.escalated ? ResolutionOutcome.not_applicable : ResolutionOutcome.not_applicable;
}

// Read
export async function findEntry(query: EntryQuery, db?: DbClient): Promise<KnowledgeEntry | null> {
    const client = db ?? getDb();
    return client.knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: query.entityType,
                entityId: query.entityId,
                key: query.key,
            },
        },
    });
}

export async function queryEntry(query: EntryQuery, db?: DbClient): Promise<QueryResult> {
    const entry = await findEntry(query, db);

    if (!entry) {
        return { found: false };
    }

    return {
        found: true,
        entry: {
            valueRaw: entry.valueRaw,
            valueSummary: entry.valueSummary,
            confidence: entry.confidence,
            source: entry.source,
            validFrom: entry.validFrom,
            validUntil: entry.validUntil,
        },
    };
}

export async function findEntriesByEntity(
    entityType: string,
    entityId: string,
    db?: DbClient
): Promise<KnowledgeEntry[]> {
    const client = db ?? getDb();
    return client.knowledgeEntry.findMany({
        where: { entityType, entityId },
        orderBy: { key: 'asc' },
    });
}

export async function findArchiveAsOf(
    query: EntryQuery,
    asOf: Date,
    options?: { includeExpired?: boolean; includeContested?: boolean },
    db?: DbClient
): Promise<Archive | null> {
    const client = db ?? getDb();
    const reasons: ArchivedReason[] = [];

    if (options?.includeContested !== false) {
        reasons.push(
            ArchivedReason.segment_closed,
            ArchivedReason.superseded,
            ArchivedReason.contradicted,
            ArchivedReason.escalated
        );
    } else {
        reasons.push(ArchivedReason.segment_closed, ArchivedReason.superseded);
    }

    if (options?.includeExpired) {
        reasons.push(ArchivedReason.expired);
    }

    return client.archive.findFirst({
        where: {
            entityType: query.entityType,
            entityId: query.entityId,
            key: query.key,
            validFrom: { lte: asOf },
            OR: [
                { validUntil: null },
                { validUntil: { gt: asOf } },
            ],
            archivedReason: { in: reasons },
        },
        orderBy: [
            { validFrom: 'desc' },
            { archivedAt: 'desc' },
        ],
    });
}

export async function findArchiveHistory(
    query: EntryQuery,
    options?: { includeExpired?: boolean; includeContested?: boolean },
    db?: DbClient
): Promise<Archive[]> {
    const client = db ?? getDb();
    const reasons: ArchivedReason[] = options?.includeContested === false
        ? [ArchivedReason.segment_closed, ArchivedReason.superseded]
        : [ArchivedReason.segment_closed, ArchivedReason.superseded, ArchivedReason.contradicted, ArchivedReason.escalated];

    if (options?.includeExpired) {
        reasons.push(ArchivedReason.expired);
    }

    return client.archive.findMany({
        where: {
            entityType: query.entityType,
            entityId: query.entityId,
            key: query.key,
            archivedReason: { in: reasons },
        },
        orderBy: [
            { validFrom: 'asc' },
            { archivedAt: 'asc' },
        ],
    });
}

export async function findPendingEscalation(
    query: EntryQuery,
    db?: DbClient
): Promise<Archive | null> {
    const client = db ?? getDb();
    return client.archive.findFirst({
        where: {
            entityType: query.entityType,
            entityId: query.entityId,
            key: query.key,
            archivedReason: ArchivedReason.escalated,
            resolutionState: ResolutionState.pending,
        },
        orderBy: { archivedAt: 'desc' },
    });
}

function normalizeSearchWeights(input: HybridSearchInput): { lexical: number; vector: number } {
    const lexical = input.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
    const vector = input.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    const total = lexical + vector;

    if (total <= 0) {
        return { lexical: DEFAULT_LEXICAL_WEIGHT, vector: DEFAULT_VECTOR_WEIGHT };
    }

    return {
        lexical: lexical / total,
        vector: vector / total,
    };
}

function buildSearchFilters(input: HybridSearchInput): Prisma.Sql[] {
    const filters: Prisma.Sql[] = [Prisma.sql`kb."isProtected" = false`];

    if (input.entityType) {
        filters.push(Prisma.sql`kb."entityType" = ${input.entityType}`);
    }

    if (input.entityId) {
        filters.push(Prisma.sql`kb."entityId" = ${input.entityId}`);
    }

    return filters;
}

function buildVectorFilter(input: HybridSearchInput): Record<string, unknown> | undefined {
    const filter: Record<string, unknown> = {};
    if (input.entityType) {
        filter.entityType = input.entityType;
    }
    if (input.entityId) {
        filter.entityId = input.entityId;
    }
    return Object.keys(filter).length > 0 ? filter : undefined;
}

function mapHybridRows(rows: HybridSearchRow[]): HybridSearchResult[] {
    return rows.map((row) => ({
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        key: row.key,
        valueRaw: row.valueRaw,
        valueSummary: row.valueSummary,
        confidence: row.confidence,
        source: row.source,
        validUntil: row.validUntil,
        lexicalScore: coerceScore(row.lexicalScore),
        vectorScore: coerceScore(row.vectorScore),
        score: coerceScore(row.score),
    }));
}

async function fetchLexicalCandidateIds(
    input: HybridSearchInput,
    db: DbClient,
    limit: number
): Promise<number[]> {
    const filters = buildSearchFilters(input);
    const rows = await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT kb."id"
        FROM "knowledge_base" kb
        WHERE ${Prisma.join(filters, ' AND ')}
        ORDER BY ts_rank_cd(
            to_tsvector('english', coalesce(kb."key", '') || ' ' || coalesce(kb."valueSummary", '')),
            websearch_to_tsquery('english', ${input.query})
        ) DESC
        LIMIT ${limit}
    `);
    return rows.map((row) => row.id);
}

async function scoreHybridCandidates(
    candidateIds: number[],
    input: HybridSearchInput,
    db: DbClient
): Promise<HybridSearchRow[]> {
    if (candidateIds.length === 0) {
        return [];
    }

    const idRows = Prisma.join(candidateIds.map((id) => Prisma.sql`(${id})`), ', ');
    return db.$queryRaw<HybridSearchRow[]>(Prisma.sql`
        WITH candidate_ids("id") AS (
            VALUES ${idRows}
        )
        SELECT
            kb."id",
            kb."entityType",
            kb."entityId",
            kb."key",
            kb."valueRaw",
            kb."valueSummary",
            kb."confidence",
            kb."source",
            kb."validUntil",
            ts_rank_cd(
                to_tsvector('english', coalesce(kb."key", '') || ' ' || coalesce(kb."valueSummary", '')),
                websearch_to_tsquery('english', ${input.query})
            ) AS "lexicalScore",
            0::float8 AS "vectorScore",
            0::float8 AS "score"
        FROM "knowledge_base" kb
        INNER JOIN candidate_ids c ON c."id" = kb."id"
    `);
}

async function lexicalSearch(
    input: HybridSearchInput,
    db: DbClient,
    limit: number,
    minScore: number,
    lexicalWeight: number
): Promise<HybridSearchResult[]> {
    const filters = buildSearchFilters(input);

    const rows = await db.$queryRaw<HybridSearchRow[]>(Prisma.sql`
        WITH scored AS (
            SELECT
                kb."id",
                kb."entityType",
                kb."entityId",
                kb."key",
                kb."valueRaw",
                kb."valueSummary",
                kb."confidence",
                kb."source",
                kb."validUntil",
                ts_rank_cd(
                    to_tsvector('english', coalesce(kb."key", '') || ' ' || coalesce(kb."valueSummary", '')),
                    websearch_to_tsquery('english', ${input.query})
                ) AS "lexicalScore"
            FROM "knowledge_base" kb
            WHERE ${Prisma.join(filters, ' AND ')}
        )
        SELECT
            "id",
            "entityType",
            "entityId",
            "key",
            "valueRaw",
            "valueSummary",
            "confidence",
            "source",
            "validUntil",
            "lexicalScore",
            0::float8 AS "vectorScore",
            (${lexicalWeight} * "lexicalScore") AS "score"
        FROM scored
        WHERE (${lexicalWeight} * "lexicalScore") >= ${minScore}
        ORDER BY "score" DESC
        LIMIT ${limit}
    `);

    return mapHybridRows(rows);
}

export async function searchEntriesHybrid(input: HybridSearchInput, db?: DbClient): Promise<HybridSearchResult[]> {
    const query = input.query?.trim();
    if (!query) {
        throw new Error('search query is required');
    }

    const client = db ?? getDb();
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const minScore = Math.max(input.minScore ?? DEFAULT_MIN_SCORE, 0);
    const weights = normalizeSearchWeights(input);
    const normalizedInput = { ...input, query };
    const backend = getVectorBackendSingleton();

    if (!(await backend.ping())) {
        return lexicalSearch(normalizedInput, client, limit, minScore, weights.lexical);
    }

    try {
        const [lexicalIds, vectorResults] = await Promise.all([
            fetchLexicalCandidateIds(normalizedInput, client, 200),
            backend.search(generateEmbedding(query), 200, buildVectorFilter(normalizedInput)),
        ]);

        const vectorScores = new Map<number, number>();
        for (const result of vectorResults) {
            const rawId = result.metadata.id;
            const id = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId), 10);
            if (Number.isFinite(id)) {
                vectorScores.set(id, result.score);
            }
        }

        const candidateIds = Array.from(new Set([
            ...lexicalIds,
            ...vectorScores.keys(),
        ]));

        const rows = await scoreHybridCandidates(candidateIds, normalizedInput, client);
        const scored = rows
            .map((row) => {
                const vectorScore = vectorScores.get(row.id) ?? 0;
                const lexicalScore = coerceScore(row.lexicalScore);
                const score = (weights.lexical * lexicalScore) + (weights.vector * vectorScore);
                return {
                    ...row,
                    lexicalScore,
                    vectorScore,
                    score,
                };
            })
            .filter((row) => row.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        return mapHybridRows(scored);
    } catch (error) {
        console.warn(`[vector] Falling back to lexical-only search: ${error instanceof Error ? error.message : String(error)}`);
        return lexicalSearch(normalizedInput, client, limit, minScore, weights.lexical);
    }
}

// Write
export async function createEntry(input: EntryInput, db?: DbClient): Promise<KnowledgeEntry> {
    const client = db ?? getDb();
    const reliabilityScores = await getReliabilityScores().catch(() => ({}));
    const originalConfidence = readOriginalConfidence(input.properties, input.confidence);
    const mergedProperties = {
        ...(input.properties ?? {}),
        originalConfidence,
    };
    const entry = await client.knowledgeEntry.create({
        data: {
            entityType: input.entityType,
            entityId: input.entityId,
            key: input.key,
            valueRaw: input.valueRaw as Prisma.InputJsonValue,
            valueSummary: input.valueSummary,
            confidence: input.confidence,
            source: input.source,
            validFrom: input.validFrom ?? new Date(),
            validUntil: input.validUntil ?? null,
            lastAccessedAt: input.lastAccessedAt ?? new Date(),
            stability: input.stability ?? initialStabilityFromReliability(
                getScore(reliabilityScores, input.source),
                getDecayConfig()
            ),
            createdBy: input.createdBy,
            isProtected: input.isProtected ?? false,
            conflictLog: (input.conflictLog ?? []) as unknown as Prisma.InputJsonValue,
            properties: mergedProperties as Prisma.InputJsonValue,
        },
    });

    await saveEmbedding(entry.id, buildEmbeddingText(entry.key, entry.valueSummary, entry.valueRaw));

    return entry;
}

export async function updateEntry(
    query: EntryQuery,
    updates: Partial<EntryInput>,
    db?: DbClient
): Promise<KnowledgeEntry> {
    const { valueRaw, conflictLog, properties, ...rest } = updates;
    const client = db ?? getDb();

    const entry = await client.knowledgeEntry.update({
        where: {
            entityType_entityId_key: {
                entityType: query.entityType,
                entityId: query.entityId,
                key: query.key,
            },
        },
        data: {
            ...rest,
            ...(valueRaw !== undefined && {
                valueRaw: valueRaw as Prisma.InputJsonValue,
            }),
            ...(conflictLog !== undefined && {
                conflictLog: conflictLog as unknown as Prisma.InputJsonValue,
            }),
            ...(properties !== undefined && {
                properties: properties as Prisma.InputJsonValue,
            }),
            updatedAt: new Date(),
        },
    });

    await saveEmbedding(entry.id, buildEmbeddingText(entry.key, entry.valueSummary, entry.valueRaw));

    return entry;
}

export async function deleteEntryById(entryId: number, db?: DbClient): Promise<void> {
    const client = db ?? getDb();
    await getVectorBackendSingleton().delete(String(entryId)).catch(() => undefined);
    await client.knowledgeEntry.delete({
        where: { id: entryId },
    });
}

export async function insertArchiveFromCurrent(
    entry: KnowledgeEntry,
    options: TemporalArchiveOptions,
    db?: DbClient
): Promise<Archive> {
    const client = db ?? getDb();
    return client.archive.create({
        data: {
            entityType: entry.entityType,
            entityId: entry.entityId,
            key: entry.key,
            valueRaw: entry.valueRaw as Prisma.InputJsonValue,
            valueSummary: entry.valueSummary,
            confidence: entry.confidence,
            source: entry.source,
            validFrom: options.validFrom ?? entry.validFrom,
            validUntil: options.validUntil ?? entry.validUntil,
            createdBy: entry.createdBy,
            createdAt: entry.createdAt,
            conflictLog: entry.conflictLog as Prisma.InputJsonValue,
            properties: entry.properties as Prisma.InputJsonValue,
            archivedReason: options.reason,
            resolutionState: options.resolutionState ?? defaultResolutionState(options.reason),
            resolutionOutcome: options.resolutionOutcome ?? defaultResolutionOutcome(options.reason),
            supersededByEntityType: options.supersededBy?.entityType ?? null,
            supersededByEntityId: options.supersededBy?.entityId ?? null,
            supersededByKey: options.supersededBy?.key ?? null,
        },
    });
}

export async function archiveEntry(
    entry: KnowledgeEntry,
    reason: ArchivedReason,
    supersededBy?: SupersededByPointer,
    db?: DbClient
): Promise<void> {
    await insertArchiveFromCurrent(entry, {
        reason,
        supersededBy,
        validFrom: entry.validFrom,
        validUntil: entry.validUntil ?? new Date(),
    }, db);
    await deleteEntryById(entry.id, db);
}

export async function updateArchiveEntry(
    id: number,
    updates: {
        validUntil?: Date | null;
        resolutionState?: ResolutionState;
        resolutionOutcome?: ResolutionOutcome;
    },
    db?: DbClient
): Promise<Archive> {
    const client = db ?? getDb();
    return client.archive.update({
        where: { id },
        data: updates,
    });
}

export async function recordKnowledgeEntryAccess(
    entryIds: number[],
    db?: DbClient
): Promise<void> {
    const ids = Array.from(new Set(entryIds.filter((id) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) {
        return;
    }

    const client = db ?? getDb();
    const decayConfig = getDecayConfig();
    const now = new Date();

    await client.$executeRaw(Prisma.sql`
        UPDATE "knowledge_base"
        SET
            "lastAccessedAt" = ${now},
            "stability" = LEAST(
                COALESCE("stability", ${decayConfig.stabilityBase}) + ${decayConfig.stabilityIncrement},
                ${decayConfig.stabilityMax}
            )
        WHERE "id" IN (${Prisma.join(ids)})
    `);
}

// Guards
const STAFF_NAMESPACES = ['system'];
const STAFF_WRITERS = new Set([
    'seed',
    'archivist',
    'attendant',
    'librarian',
    'system',
]);

export async function isProtectedEntry(query: EntryQuery, db?: DbClient): Promise<boolean> {
    const entry = await findEntry(query, db);
    return entry?.isProtected ?? false;
}

export function isStaffNamespace(entityType: string): boolean {
    return STAFF_NAMESPACES.includes(entityType);
}

export function canWriteToStaffNamespace(createdBy: string, entityType: string): boolean {
    if (!isStaffNamespace(entityType)) return true;
    return STAFF_WRITERS.has(createdBy.toLowerCase());
}

// Conflict Log
export async function appendConflictLog(entryId: number, event: any, db?: DbClient) {
    const client = db ?? getDb();
    const existing = await client.knowledgeEntry.findUnique({
        where: { id: entryId },
        select: { conflictLog: true },
    });

    const current = (existing?.conflictLog ?? []) as any[];
    const next = [...current, event];

    return client.knowledgeEntry.update({
        where: { id: entryId },
        data: { conflictLog: next as Prisma.InputJsonValue },
    });
}

// Write Receipts (Idempotency)
export async function getWriteReceipt(requestId: string, db?: DbClient) {
    const client = db ?? getDb();
    return client.writeReceipt.findUnique({ where: { requestId } });
}

export async function createWriteReceipt(data: {
    requestId: string;
    entityType: string;
    entityId: string;
    key: string;
    outcome: string;
    resultEntryId?: number | null;
    escalationFile?: string | null;
}, db?: DbClient) {
    const client = db ?? getDb();
    return client.writeReceipt.create({ data });
}
