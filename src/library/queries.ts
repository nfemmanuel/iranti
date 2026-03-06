import { getDb } from './client';
import {
    EntryInput,
    EntryQuery,
    HybridSearchInput,
    HybridSearchResult,
    QueryResult,
} from '../types';
import { KnowledgeEntry, Prisma, PrismaClient } from '../generated/prisma/client';
import { buildEmbeddingText, generateEmbedding, toPgVectorLiteral } from './embeddings';

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

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_LEXICAL_WEIGHT = 0.45;
const DEFAULT_VECTOR_WEIGHT = 0.55;
const DEFAULT_MIN_SCORE = 0;

let vectorSupportCache: boolean | null = null;

function isVectorRuntimeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
        message.includes('type "vector" does not exist') ||
        message.includes('operator does not exist: vector') ||
        message.includes('column "embedding" does not exist')
    );
}

function coerceScore(value: number | string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function hasVectorSupport(db: DbClient): Promise<boolean> {
    if (vectorSupportCache !== null) {
        return vectorSupportCache;
    }

    try {
        const rows = await db.$queryRaw<Array<{ has_vector: boolean; has_embedding: boolean }>>(Prisma.sql`
            SELECT
                EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') AS has_vector,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'knowledge_base'
                      AND column_name = 'embedding'
                ) AS has_embedding
        `);
        vectorSupportCache = Boolean(rows[0]?.has_vector && rows[0]?.has_embedding);
    } catch {
        vectorSupportCache = false;
    }

    return vectorSupportCache;
}

async function saveEmbedding(entryId: number, text: string, db: DbClient): Promise<void> {
    if (!(await hasVectorSupport(db))) {
        return;
    }

    try {
        const vector = generateEmbedding(text);
        const vectorLiteral = toPgVectorLiteral(vector);

        await db.$executeRaw(Prisma.sql`
            UPDATE "knowledge_base"
            SET "embedding" = ${vectorLiteral}::vector
            WHERE "id" = ${entryId}
        `);
    } catch (error) {
        if (isVectorRuntimeError(error)) {
            vectorSupportCache = false;
            return;
        }
        throw error;
    }
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

    if (!(await hasVectorSupport(client))) {
        return lexicalSearch(normalizedInput, client, limit, minScore, weights.lexical);
    }

    try {
        const filters = buildSearchFilters(normalizedInput);
        const vectorLiteral = toPgVectorLiteral(generateEmbedding(query));

        const rows = await client.$queryRaw<HybridSearchRow[]>(Prisma.sql`
            WITH candidate_lexical AS (
                SELECT kb."id"
                FROM "knowledge_base" kb
                WHERE ${Prisma.join(filters, ' AND ')}
                ORDER BY ts_rank_cd(
                    to_tsvector('english', coalesce(kb."key", '') || ' ' || coalesce(kb."valueSummary", '')),
                    websearch_to_tsquery('english', ${query})
                ) DESC
                LIMIT 200
            ),
            candidate_vector AS (
                SELECT kb."id"
                FROM "knowledge_base" kb
                WHERE ${Prisma.join(filters, ' AND ')}
                  AND kb."embedding" IS NOT NULL
                ORDER BY kb."embedding" <=> ${vectorLiteral}::vector ASC
                LIMIT 200
            ),
            candidates AS (
                SELECT "id" FROM candidate_lexical
                UNION
                SELECT "id" FROM candidate_vector
            ),
            scored AS (
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
                        websearch_to_tsquery('english', ${query})
                    ) AS "lexicalScore",
                    CASE
                        WHEN kb."embedding" IS NULL THEN 0::float8
                        ELSE (1 - (kb."embedding" <=> ${vectorLiteral}::vector))
                    END AS "vectorScore"
                FROM "knowledge_base" kb
                INNER JOIN candidates c ON c."id" = kb."id"
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
                "vectorScore",
                (${weights.lexical} * "lexicalScore" + ${weights.vector} * "vectorScore") AS "score"
            FROM scored
            WHERE (${weights.lexical} * "lexicalScore" + ${weights.vector} * "vectorScore") >= ${minScore}
            ORDER BY "score" DESC
            LIMIT ${limit}
        `);

        return mapHybridRows(rows);
    } catch (error) {
        if (isVectorRuntimeError(error)) {
            vectorSupportCache = false;
            return lexicalSearch(normalizedInput, client, limit, minScore, weights.lexical);
        }
        throw error;
    }
}

// Write
export async function createEntry(input: EntryInput, db?: DbClient): Promise<KnowledgeEntry> {
    const client = db ?? getDb();
    const entry = await client.knowledgeEntry.create({
        data: {
            entityType: input.entityType,
            entityId: input.entityId,
            key: input.key,
            valueRaw: input.valueRaw as Prisma.InputJsonValue,
            valueSummary: input.valueSummary,
            confidence: input.confidence,
            source: input.source,
            validUntil: input.validUntil,
            createdBy: input.createdBy,
            isProtected: input.isProtected ?? false,
            conflictLog: (input.conflictLog ?? []) as unknown as Prisma.InputJsonValue,
        },
    });

    await saveEmbedding(
        entry.id,
        buildEmbeddingText(entry.key, entry.valueSummary, entry.valueRaw),
        client
    );

    return entry;
}

export async function updateEntry(
    query: EntryQuery,
    updates: Partial<EntryInput>,
    db?: DbClient
): Promise<KnowledgeEntry> {
    const { valueRaw, conflictLog, ...rest } = updates;
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
            updatedAt: new Date(),
        },
    });

    await saveEmbedding(
        entry.id,
        buildEmbeddingText(entry.key, entry.valueSummary, entry.valueRaw),
        client
    );

    return entry;
}

// Archive
type SupersededByPointer = {
    entityType: string;
    entityId: string;
    key: string;
};

export async function archiveEntry(
    entry: KnowledgeEntry,
    reason: 'superseded' | 'contradicted' | 'expired' | 'duplicate',
    supersededBy?: SupersededByPointer,
    db?: DbClient
): Promise<void> {
    const client = db ?? getDb();
    await Promise.all([
        client.archive.create({
            data: {
                entityType: entry.entityType,
                entityId: entry.entityId,
                key: entry.key,
                valueRaw: entry.valueRaw as Prisma.InputJsonValue,
                valueSummary: entry.valueSummary,
                confidence: entry.confidence,
                source: entry.source,
                validUntil: entry.validUntil,
                createdBy: entry.createdBy,
                createdAt: entry.createdAt,
                conflictLog: entry.conflictLog as Prisma.InputJsonValue,
                archivedReason: reason,
                supersededByEntityType: supersededBy?.entityType ?? null,
                supersededByEntityId: supersededBy?.entityId ?? null,
                supersededByKey: supersededBy?.key ?? null,
            },
        }),
        client.knowledgeEntry.update({
            where: { id: entry.id },
            data: {
                valueSummary: '[ARCHIVED]',
                confidence: 0,
                updatedAt: new Date(),
            },
        }),
    ]);
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
