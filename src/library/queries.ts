import { getDb } from './client';
import { EntryInput, EntryQuery, QueryResult } from '../types';
import { KnowledgeEntry, Prisma, PrismaClient } from '../generated/prisma/client';

type DbClient = PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// ─── Read ────────────────────────────────────────────────────────────────────

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

// ─── Write ───────────────────────────────────────────────────────────────────

export async function createEntry(input: EntryInput, db?: DbClient): Promise<KnowledgeEntry> {
    const client = db ?? getDb();
    return client.knowledgeEntry.create({
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
            conflictLog: (input.conflictLog ?? []) as Prisma.InputJsonValue,
        },
    });
}

export async function updateEntry(
    query: EntryQuery,
    updates: Partial<EntryInput>,
    db?: DbClient
): Promise<KnowledgeEntry> {
    const { valueRaw, conflictLog, ...rest } = updates;
    const client = db ?? getDb();

    return client.knowledgeEntry.update({
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
}

// ─── Archive ─────────────────────────────────────────────────────────────────

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
                supersededBy: null,
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
                updatedAt: new Date()
            },
        }),
    ]);
}

// ─── Guards ──────────────────────────────────────────────────────────────────

const STAFF_NAMESPACES = ['system', 'agent'];
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

export function canWriteToStaffNamespace(createdBy: string, entityType: string, key?: string): boolean {
    if (!isStaffNamespace(entityType)) return true;
    
    const writer = createdBy.toLowerCase();
    if (STAFF_WRITERS.has(writer)) return true;
    
    // Allow agents to write their own attendant_state only
    if (entityType === 'agent' && key === 'attendant_state') return true;
    return false;
}

// ─── Conflict Log ────────────────────────────────────────────────────────────

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

// ─── Write Receipts (Idempotency) ────────────────────────────────────────────

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