/**
 * Knowledge store query layer for iranti.
 *
 * The central CRUD and search interface over the `knowledge_base` (Prisma
 * `knowledgeEntry`) table and related tables. All reads and writes go through
 * this module so the vector index, decay metadata, and conflict log stay
 * consistent with the relational rows.
 *
 * Key operations:
 *  - `findEntry` / `findEntriesByEntity` — point lookups and entity scans
 *  - `createEntry` — insert + save vector embedding + set initial stability
 *  - `archiveEntry` / `insertArchiveFromCurrent` — move row to archive table
 *  - `appendConflictLog` — append a conflict event to the entry's JSONB log
 *  - `hybridSearch` — lexical (full-text) + vector (cosine) weighted search;
 *    falls back to pure lexical when the vector backend is unavailable
 *  - `searchWithBridging` — extends hybrid search by walking the entity
 *    relationship graph up to `SEARCH_BRIDGE_MAX_HOPS` hops from top results
 *  - `checkVectorIndexConsistency` / `repairVectorIndex` — audit and repair
 *    drift between the relational store and the vector backend
 *  - Write receipt helpers (M-2): `claimWriteReceiptSlot`, `getWriteReceipt`,
 *    `clearPendingWriteReceiptSlot`
 *
 * `DbClient` accepts both the full `PrismaClient` and transaction clients so
 * callers can pass either `getDb()` or a Prisma transaction `tx`.
 */

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
import { buildEmbeddingText, cosineSimilarity, generateEmbedding } from './embeddings';
import { getScore, getReliabilityScores } from '../librarian/source-reliability';
import { getDecayConfig, initialStabilityFromReliability, readOriginalConfidence } from '../lib/decay';
import { createVectorBackend } from './backends';
import { VectorBackend, VectorConsistencyFilter } from './vectorBackend';

type DbClient = PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

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

type HybridFallbackEntry = Pick<
    KnowledgeEntry,
    'id' | 'entityType' | 'entityId' | 'key' | 'valueRaw' | 'valueSummary' | 'confidence' | 'source' | 'validUntil'
>;

type SearchEntityRef = {
    entityType: string;
    entityId: string;
};

type BridgedTarget = SearchEntityRef & {
    score: number;
    depth: number;
};

export type ArchiveHistoryEntry = Archive;

export type VectorIndexConsistencyReport = {
    backend: string;
    reachable: boolean;
    repairable: boolean;
    consistent: boolean;
    expectedCount: number;
    indexedCount: number;
    missingEntryIds: string[];
    orphanedVectorIds: string[];
};

export type VectorIndexRepairReport = VectorIndexConsistencyReport & {
    repairedMissingCount: number;
    removedOrphanedCount: number;
};

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
const DEFAULT_VECTOR_FALLBACK_SCAN_LIMIT = 2000;
const SEARCH_BRIDGE_MAX_HOPS = 2;
const SEARCH_BRIDGE_SEED_LIMIT = 24;
const SEARCH_BRIDGE_MIN_SCORE = 0.25;
const SEARCH_BRIDGE_HOP_PENALTY = 0.82;
const SEARCH_BRIDGE_MAX_RESULTS_PER_ENTITY = 3;
const SEARCH_BRIDGE_PRIORITY_KEYS = ['status', 'summary', 'checkpoint_summary', 'next_step', 'current_step', 'blocker', 'open_risks'];

let vectorBackend: VectorBackend | null = null;

export function __setVectorBackendSingletonForTests(backend: VectorBackend | null): void {
    vectorBackend = backend;
}

function coerceScore(value: number | string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildHybridLexicalDocumentSql(): Prisma.Sql {
    return Prisma.sql`
        coalesce(kb."entityType", '')
        || ' '
        || coalesce(kb."entityId", '')
        || ' '
        || regexp_replace(coalesce(kb."entityId", ''), '[-_/]+', ' ', 'g')
        || ' '
        || coalesce(kb."key", '')
        || ' '
        || coalesce(kb."valueSummary", '')
    `;
}

export function getVectorBackendSingleton(): VectorBackend {
    if (!vectorBackend) {
        vectorBackend = createVectorBackend();
    }
    return vectorBackend;
}

async function saveEmbedding(
    entry: Pick<KnowledgeEntry, 'id' | 'entityType' | 'entityId' | 'key' | 'valueSummary' | 'valueRaw' | 'source'>,
    db?: DbClient
): Promise<void> {
    const text = buildEmbeddingText({
        entityType: entry.entityType,
        entityId: entry.entityId,
        key: entry.key,
        summary: entry.valueSummary,
        valueRaw: entry.valueRaw,
    });
    await getVectorBackendSingleton().upsert({
        id: String(entry.id),
        vector: generateEmbedding(text),
        metadata: {
            id: entry.id,
            entityType: entry.entityType,
            entityId: entry.entityId,
            key: entry.key,
            summary: entry.valueSummary,
            source: entry.source,
            text,
        },
    }, db);
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

export async function findEntriesByEntityType(
    entityType: string,
    db?: DbClient
): Promise<KnowledgeEntry[]> {
    const client = db ?? getDb();
    return client.knowledgeEntry.findMany({
        where: { entityType },
        orderBy: [{ entityId: 'asc' }, { key: 'asc' }],
    });
}

export async function listAttendantStateEntries(
    filters?: { agentId?: string },
    db?: DbClient
): Promise<Array<Pick<KnowledgeEntry, 'entityId' | 'valueRaw' | 'updatedAt'>>> {
    const client = db ?? getDb();
    return client.knowledgeEntry.findMany({
        where: {
            entityType: 'agent',
            key: 'attendant_state',
            ...(filters?.agentId ? { entityId: filters.agentId } : {}),
        },
        select: {
            entityId: true,
            valueRaw: true,
            updatedAt: true,
        },
        orderBy: [
            { updatedAt: 'desc' },
            { entityId: 'asc' },
        ],
    });
}

/**
 * A2: reverse-index query used by `iranti revert-autowrite`. Finds all
 * knowledge entries written with a specific `source` tag inside a
 * time window. The Attendant stamps every autowrite with
 * source='attendant_autowrite' and an autowriteBatchId in properties, so
 * this pair (source, createdAt window) is enough to list every autowrite
 * the agent performed in the last N minutes/hours.
 *
 * Returned entries include their id so the caller can call deleteEntryById
 * on each one — we intentionally do NOT delete here, because the CLI
 * defaults to --dry-run and should print targets before destroying them.
 *
 * @param source The source label to match (e.g. 'attendant_autowrite').
 * @param since  Lower bound (inclusive) on createdAt. Entries created at or
 *               after this timestamp are eligible.
 * @param until  Optional upper bound (inclusive). Defaults to now — callers
 *               can narrow to a specific window for deterministic rollback.
 */
export async function findEntriesBySourceAndWindow(
    source: string,
    since: Date,
    until?: Date,
    db?: DbClient
): Promise<KnowledgeEntry[]> {
    const client = db ?? getDb();
    return client.knowledgeEntry.findMany({
        where: {
            source,
            createdAt: {
                gte: since,
                ...(until ? { lte: until } : {}),
            },
        },
        orderBy: [{ createdAt: 'desc' }],
    });
}

/**
 * A2: destructive counterpart to findEntriesBySourceAndWindow. Deletes
 * every knowledge entry matching (source, createdAt window) and returns
 * the count deleted. Meant to be called only from the CLI after the
 * dry-run preview has been shown to the user. Uses a single deleteMany
 * query so it is atomic at the Prisma level.
 */
export async function deleteEntriesBySourceAndWindow(
    source: string,
    since: Date,
    until?: Date,
    db?: DbClient
): Promise<number> {
    const client = db ?? getDb();
    const result = await client.knowledgeEntry.deleteMany({
        where: {
            source,
            createdAt: {
                gte: since,
                ...(until ? { lte: until } : {}),
            },
        },
    });
    return result.count;
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
            { id: 'desc' },
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
            { id: 'asc' },
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
        orderBy: [
            { archivedAt: 'desc' },
            { id: 'desc' },
        ],
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

function resolveFallbackScanLimit(limit: number): number {
    const configuredLimit = Number.parseInt(process.env.IRANTI_VECTOR_FALLBACK_SCAN_LIMIT ?? '', 10);
    if (Number.isFinite(configuredLimit) && configuredLimit > 0) {
        return Math.max(limit, configuredLimit);
    }
    return Math.max(limit, DEFAULT_VECTOR_FALLBACK_SCAN_LIMIT);
}

async function fetchFallbackEntries(
    input: Pick<HybridSearchInput, 'entityType' | 'entityId'>,
    db: DbClient,
    take: number
): Promise<HybridFallbackEntry[]> {
    return db.knowledgeEntry.findMany({
        where: {
            isProtected: false,
            ...(input.entityType ? { entityType: input.entityType } : {}),
            ...(input.entityId ? { entityId: input.entityId } : {}),
        },
        select: {
            id: true,
            entityType: true,
            entityId: true,
            key: true,
            valueRaw: true,
            valueSummary: true,
            confidence: true,
            source: true,
            validUntil: true,
        },
        orderBy: { updatedAt: 'desc' },
        take,
    });
}

async function scoreFallbackEntries(
    input: HybridSearchInput,
    db: DbClient,
    take: number,
    minScore: number,
    weights: { lexical: number; vector: number }
): Promise<HybridSearchResult[]> {
    const entries = await fetchFallbackEntries(input, db, take);
    if (entries.length === 0) {
        return [];
    }

    const lexicalRows = await scoreHybridCandidates(entries.map((entry: HybridFallbackEntry) => entry.id), input, db);
    const lexicalById = new Map<number, number>();
    for (const row of lexicalRows) {
        lexicalById.set(row.id, coerceScore(row.lexicalScore));
    }

    const queryEmbedding = generateEmbedding(input.query);
    const scored = entries
        .map((entry: HybridFallbackEntry) => {
            const lexicalScore = lexicalById.get(entry.id) ?? 0;
            const vectorScore = cosineSimilarity(
                queryEmbedding,
                generateEmbedding(buildEmbeddingText({
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    key: entry.key,
                    summary: entry.valueSummary,
                    valueRaw: entry.valueRaw,
                })),
            );
            const score = (weights.lexical * lexicalScore) + (weights.vector * vectorScore);

            return {
                ...entry,
                lexicalScore,
                vectorScore,
                score,
            };
        })
        .filter((entry: HybridSearchResult) => entry.score >= minScore)
        .filter((entry: HybridSearchResult) => entry.lexicalScore > 0 || entry.vectorScore > 0)
        .sort((left: HybridSearchResult, right: HybridSearchResult) => right.score - left.score);

    return mapHybridRows(scored);
}

function matchesTargetEntity(input: HybridSearchInput, entity: SearchEntityRef): boolean {
    if (!input.entityType) {
        return false;
    }
    if (entity.entityType !== input.entityType) {
        return false;
    }
    if (input.entityId && entity.entityId !== input.entityId) {
        return false;
    }
    return true;
}

async function getRelatedEntitiesForSearch(
    entity: SearchEntityRef,
    db: DbClient,
    cache: Map<string, SearchEntityRef[]>
): Promise<SearchEntityRef[]> {
    const cacheKey = `${entity.entityType}/${entity.entityId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const [outbound, inbound] = await Promise.all([
        db.entityRelationship.findMany({
            where: { fromType: entity.entityType, fromId: entity.entityId },
            select: { toType: true, toId: true },
            take: 12,
        }),
        db.entityRelationship.findMany({
            where: { toType: entity.entityType, toId: entity.entityId },
            select: { fromType: true, fromId: true },
            take: 12,
        }),
    ]);

    const related = [
        ...outbound.map((row) => ({ entityType: row.toType, entityId: row.toId })),
        ...inbound.map((row) => ({ entityType: row.fromType, entityId: row.fromId })),
    ];
    cache.set(cacheKey, related);
    return related;
}

function rankBridgeEntry(left: HybridFallbackEntry, right: HybridFallbackEntry): number {
    const leftPriority = SEARCH_BRIDGE_PRIORITY_KEYS.indexOf(left.key);
    const rightPriority = SEARCH_BRIDGE_PRIORITY_KEYS.indexOf(right.key);
    const normalizedLeftPriority = leftPriority === -1 ? SEARCH_BRIDGE_PRIORITY_KEYS.length : leftPriority;
    const normalizedRightPriority = rightPriority === -1 ? SEARCH_BRIDGE_PRIORITY_KEYS.length : rightPriority;
    return normalizedLeftPriority - normalizedRightPriority
        || right.confidence - left.confidence
        || left.key.localeCompare(right.key);
}

function mergeHybridResults(
    resultSets: HybridSearchResult[][],
    weights: { lexical: number; vector: number },
    minScore: number,
    limit: number
): HybridSearchResult[] {
    const merged = new Map<number, HybridSearchResult>();
    for (const resultSet of resultSets) {
        for (const row of resultSet) {
            const existing = merged.get(row.id);
            if (!existing) {
                merged.set(row.id, { ...row });
                continue;
            }

            const lexicalScore = Math.max(existing.lexicalScore, row.lexicalScore);
            const vectorScore = Math.max(existing.vectorScore, row.vectorScore);
            const score = (weights.lexical * lexicalScore) + (weights.vector * vectorScore);
            const preferred = existing.score >= row.score ? existing : row;
            merged.set(row.id, {
                ...preferred,
                lexicalScore,
                vectorScore,
                score,
            });
        }
    }

    return Array.from(merged.values())
        .filter((row) => row.score >= minScore)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
}

async function searchEntriesViaRelationshipBridge(
    input: HybridSearchInput,
    db: DbClient,
    limit: number,
    minScore: number,
    weights: { lexical: number; vector: number }
): Promise<HybridSearchResult[]> {
    if (!input.entityType) {
        return [];
    }

    const broadHits = await scoreFallbackEntries(
        { query: input.query, limit: SEARCH_BRIDGE_SEED_LIMIT * 2 },
        db,
        resolveFallbackScanLimit(SEARCH_BRIDGE_SEED_LIMIT * 2),
        0,
        weights
    );
    const seeds = broadHits
        .filter((row) => row.score >= SEARCH_BRIDGE_MIN_SCORE)
        .slice(0, SEARCH_BRIDGE_SEED_LIMIT);
    if (seeds.length === 0) {
        return [];
    }

    const relationCache = new Map<string, SearchEntityRef[]>();
    const bridgedTargets = new Map<string, BridgedTarget>();

    for (const seed of seeds) {
        const queue: Array<{ entity: SearchEntityRef; depth: number }> = [{
            entity: { entityType: seed.entityType, entityId: seed.entityId },
            depth: 0,
        }];
        const visited = new Set<string>([`${seed.entityType}/${seed.entityId}`]);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth >= SEARCH_BRIDGE_MAX_HOPS) {
                continue;
            }

            const related = await getRelatedEntitiesForSearch(current.entity, db, relationCache);
            for (const neighbor of related) {
                const neighborKey = `${neighbor.entityType}/${neighbor.entityId}`;
                if (visited.has(neighborKey)) {
                    continue;
                }
                visited.add(neighborKey);

                const nextDepth = current.depth + 1;
                if (matchesTargetEntity(input, neighbor)) {
                    const propagatedScore = seed.score * Math.pow(SEARCH_BRIDGE_HOP_PENALTY, nextDepth);
                    const existing = bridgedTargets.get(neighborKey);
                    if (!existing || propagatedScore > existing.score) {
                        bridgedTargets.set(neighborKey, {
                            ...neighbor,
                            score: propagatedScore,
                            depth: nextDepth,
                        });
                    }
                }

                if (nextDepth < SEARCH_BRIDGE_MAX_HOPS) {
                    queue.push({ entity: neighbor, depth: nextDepth });
                }
            }
        }
    }

    const targetEntities = Array.from(bridgedTargets.values());
    if (targetEntities.length === 0) {
        return [];
    }

    const bridgedEntries = await db.knowledgeEntry.findMany({
        where: {
            isProtected: false,
            OR: targetEntities.map((target) => ({
                entityType: target.entityType,
                entityId: target.entityId,
            })),
        },
        select: {
            id: true,
            entityType: true,
            entityId: true,
            key: true,
            valueRaw: true,
            valueSummary: true,
            confidence: true,
            source: true,
            validUntil: true,
        },
    });
    if (bridgedEntries.length === 0) {
        return [];
    }

    const selectedEntries = Array.from(
        bridgedEntries.reduce((map, entry) => {
            const entityKey = `${entry.entityType}/${entry.entityId}`;
            const current = map.get(entityKey) ?? [];
            current.push(entry);
            map.set(entityKey, current);
            return map;
        }, new Map<string, HybridFallbackEntry[]>()).entries()
    ).flatMap(([, entries]) => entries.sort(rankBridgeEntry).slice(0, SEARCH_BRIDGE_MAX_RESULTS_PER_ENTITY));

    const lexicalRows = await scoreHybridCandidates(selectedEntries.map((entry) => entry.id), input, db);
    const lexicalById = new Map<number, number>();
    for (const row of lexicalRows) {
        lexicalById.set(row.id, coerceScore(row.lexicalScore));
    }

    return mapHybridRows(
        selectedEntries
            .map((entry) => {
                const entityKey = `${entry.entityType}/${entry.entityId}`;
                const target = bridgedTargets.get(entityKey);
                const vectorScore = target?.score ?? 0;
                const lexicalScore = lexicalById.get(entry.id) ?? 0;
                return {
                    ...entry,
                    lexicalScore,
                    vectorScore,
                    score: (weights.lexical * lexicalScore) + (weights.vector * vectorScore),
                };
            })
            .filter((row) => row.score >= minScore)
    );
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
          AND ts_rank_cd(
                to_tsvector('english', ${buildHybridLexicalDocumentSql()}),
                websearch_to_tsquery('english', ${input.query})
              ) > 0
        ORDER BY ts_rank_cd(
            to_tsvector('english', ${buildHybridLexicalDocumentSql()}),
            websearch_to_tsquery('english', ${input.query})
        ) DESC
        LIMIT ${limit}
    `);
    return rows.map((row: { id: number }) => row.id);
}

async function hybridSearchWithoutBackend(
    input: HybridSearchInput,
    db: DbClient,
    limit: number,
    minScore: number,
    weights: { lexical: number; vector: number }
): Promise<HybridSearchResult[]> {
    const directResults = await scoreFallbackEntries(input, db, resolveFallbackScanLimit(limit), minScore, weights);
    const bridgeResults = await searchEntriesViaRelationshipBridge(input, db, limit, minScore, weights);
    return mergeHybridResults([directResults, bridgeResults], weights, minScore, limit);
}

async function scoreHybridCandidates(
    candidateIds: number[],
    input: HybridSearchInput,
    db: DbClient
): Promise<HybridSearchRow[]> {
    if (candidateIds.length === 0) {
        return [];
    }

    const idRows = Prisma.join(candidateIds);
    return db.$queryRaw<HybridSearchRow[]>(Prisma.sql`
        WITH candidate_ids AS (
            SELECT UNNEST(ARRAY[${idRows}]::int[]) AS "id"
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
                to_tsvector('english', ${buildHybridLexicalDocumentSql()}),
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
                    to_tsvector('english', ${buildHybridLexicalDocumentSql()}),
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
        WHERE "lexicalScore" > 0
          AND (${lexicalWeight} * "lexicalScore") >= ${minScore}
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
    const bridgeResults = await searchEntriesViaRelationshipBridge(normalizedInput, client, limit, minScore, weights);

    if (!(await backend.ping())) {
        return hybridSearchWithoutBackend(normalizedInput, client, limit, minScore, weights);
    }

    try {
        const [lexicalIds, vectorResultsRaw] = await Promise.all([
            fetchLexicalCandidateIds(normalizedInput, client, 200),
            backend.search(generateEmbedding(query), 200, buildVectorFilter(normalizedInput)),
        ]);
        const vectorResults = Array.isArray(vectorResultsRaw) ? vectorResultsRaw : [];

        const vectorScores = new Map<number, number>();
        for (const result of vectorResults) {
            const rawId = result.metadata.id;
            const id = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId), 10);
            if (Number.isFinite(id)) {
                vectorScores.set(id, result.score);
            }
        }

        const candidateIds = Array.from(new Set<number>(lexicalIds.concat(Array.from(vectorScores.keys()))));

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

        return mergeHybridResults([mapHybridRows(scored), bridgeResults], weights, minScore, limit);
    } catch (error) {
        console.warn(`[vector] Falling back to lexical-only search: ${error instanceof Error ? error.message : String(error)}`);
        return hybridSearchWithoutBackend(normalizedInput, client, limit, minScore, weights);
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

    await saveEmbedding(entry, db);

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

    await saveEmbedding(entry, db);

    return entry;
}

export async function deleteEntryById(entryId: number, db?: DbClient): Promise<void> {
    const client = db ?? getDb();
    await getVectorBackendSingleton().delete(String(entryId), db).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[vector] Failed to delete vector for entryId=${entryId}: ${message}`);
        throw err;
    });
    await client.knowledgeEntry.delete({
        where: { id: entryId },
    });
}

function normalizeVectorConsistencyFilter(filter?: VectorConsistencyFilter): VectorConsistencyFilter | undefined {
    if (!filter) return undefined;
    const normalized: VectorConsistencyFilter = {};
    if (typeof filter.entityType === 'string' && filter.entityType.trim().length > 0) {
        normalized.entityType = filter.entityType.trim();
    }
    if (typeof filter.entityId === 'string' && filter.entityId.trim().length > 0) {
        normalized.entityId = filter.entityId.trim();
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function listExpectedVectorEntryIds(filter?: VectorConsistencyFilter, db?: DbClient): Promise<string[]> {
    const client = db ?? getDb();
    const entries = await client.knowledgeEntry.findMany({
        where: {
            isProtected: false,
            ...(filter?.entityType ? { entityType: filter.entityType } : {}),
            ...(filter?.entityId ? { entityId: filter.entityId } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
    });
    return entries.map((entry: { id: number }) => String(entry.id));
}

async function loadEntriesForVectorRepair(entryIds: string[], db?: DbClient): Promise<Array<Pick<KnowledgeEntry, 'id' | 'entityType' | 'entityId' | 'key' | 'valueSummary' | 'valueRaw' | 'source'>>> {
    const client = db ?? getDb();
    const ids = Array.from(new Set(entryIds
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0)));
    if (ids.length === 0) {
        return [];
    }

    return client.knowledgeEntry.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            entityType: true,
            entityId: true,
            key: true,
            valueSummary: true,
            valueRaw: true,
            source: true,
        },
        orderBy: { id: 'asc' },
    });
}

export async function auditVectorIndexConsistency(filter?: VectorConsistencyFilter, db?: DbClient): Promise<VectorIndexConsistencyReport> {
    const normalizedFilter = normalizeVectorConsistencyFilter(filter);
    const backend = getVectorBackendSingleton();
    const backendName = process.env.IRANTI_VECTOR_BACKEND?.trim().toLowerCase() || 'pgvector';
    const reachable = await backend.ping();
    const expectedIds = await listExpectedVectorEntryIds(normalizedFilter, db);

    if (!reachable) {
        return {
            backend: backendName,
            reachable: false,
            repairable: false,
            consistent: false,
            expectedCount: expectedIds.length,
            indexedCount: 0,
            missingEntryIds: expectedIds,
            orphanedVectorIds: [],
        };
    }

    const indexedIds = await backend.listIndexedIds(normalizedFilter);
    const expectedSet = new Set(expectedIds);
    const indexedSet = new Set(indexedIds);

    const missingEntryIds = expectedIds.filter((id) => !indexedSet.has(id));
    const orphanedVectorIds = indexedIds.filter((id) => !expectedSet.has(id));

    return {
        backend: backendName,
        reachable: true,
        repairable: true,
        consistent: missingEntryIds.length === 0 && orphanedVectorIds.length === 0,
        expectedCount: expectedIds.length,
        indexedCount: indexedIds.length,
        missingEntryIds,
        orphanedVectorIds,
    };
}

export async function repairVectorIndexConsistency(
    filter?: VectorConsistencyFilter,
    options: { repopulateMissing?: boolean; removeOrphaned?: boolean } = {},
    db?: DbClient
): Promise<VectorIndexRepairReport> {
    const backend = getVectorBackendSingleton();
    const repopulateMissing = options.repopulateMissing !== false;
    const removeOrphaned = options.removeOrphaned !== false;
    const baseline = await auditVectorIndexConsistency(filter, db);

    let repairedMissingCount = 0;
    let removedOrphanedCount = 0;

    if (baseline.reachable) {
        if (repopulateMissing && baseline.missingEntryIds.length > 0) {
            const entries = await loadEntriesForVectorRepair(baseline.missingEntryIds, db);
            for (const entry of entries) {
                await saveEmbedding(entry, db);
                repairedMissingCount += 1;
            }
        }

        if (removeOrphaned && baseline.orphanedVectorIds.length > 0) {
            for (const orphanedId of baseline.orphanedVectorIds) {
                await backend.delete(orphanedId, db);
                removedOrphanedCount += 1;
            }
        }
    }

    const after = await auditVectorIndexConsistency(filter, db);
    return {
        ...after,
        repairedMissingCount,
        removedOrphanedCount,
    };
}

function supportsInteractiveTransactions(client: DbClient): client is PrismaClient {
    return typeof (client as PrismaClient).$transaction === 'function';
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
    const archiveOptions = {
        reason,
        supersededBy,
        validFrom: entry.validFrom,
        validUntil: entry.validUntil ?? new Date(),
    };
    const client = db ?? getDb();
    const runArchiveMutation = async (tx: DbClient) => {
        await insertArchiveFromCurrent(entry, archiveOptions, tx);
        await deleteEntryById(entry.id, tx);
    };

    if (supportsInteractiveTransactions(client)) {
        await client.$transaction(async (tx: TransactionClient) => {
            await runArchiveMutation(tx);
        });
        return;
    }

    await runArchiveMutation(client);
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
const STAFF_NAMESPACES = (process.env.IRANTI_STAFF_NAMESPACES ?? 'system')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const STAFF_WRITERS = new Set(
    (process.env.IRANTI_STAFF_WRITERS ?? 'seed,archivist,attendant,librarian,system')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
);

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
export async function appendConflictLog(entryId: number, event: unknown, db?: DbClient) {
    const client = db ?? getDb();
    const eventJson = JSON.stringify(event);
    await client.$executeRaw`
        UPDATE "knowledge_base"
        SET "conflictLog" = COALESCE("conflictLog", '[]'::jsonb) || ${eventJson}::jsonb
        WHERE "id" = ${entryId}
    `;
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

// M-2: Reserves a requestId before the write begins (pending-before-write pattern).
// Returns true if the slot was claimed (proceed with write), false if already claimed by a concurrent request.
export async function claimWriteReceiptSlot(data: {
    requestId: string;
    entityType: string;
    entityId: string;
    key: string;
}, db?: DbClient): Promise<boolean> {
    const client = db ?? getDb();
    try {
        await client.writeReceipt.create({
            data: { ...data, outcome: 'pending' },
        });
        return true;
    } catch (err) {
        // Unique constraint violation means another request already claimed this requestId
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Unique constraint') || msg.includes('unique constraint') || msg.includes('P2002')) {
            return false;
        }
        throw err;
    }
}

export async function clearPendingWriteReceiptSlot(requestId: string, db?: DbClient): Promise<void> {
    const client = db ?? getDb();
    await client.writeReceipt.deleteMany({
        where: {
            requestId,
            outcome: 'pending',
        },
    });
}

export async function updateWriteReceiptOutcome(requestId: string, outcome: string, resultEntryId?: number | null, escalationFile?: string | null, db?: DbClient): Promise<void> {
    const client = db ?? getDb();
    await client.writeReceipt.update({
        where: { requestId },
        data: { outcome, resultEntryId, escalationFile },
    });
}
