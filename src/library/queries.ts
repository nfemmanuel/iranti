import { prisma } from './client';
import { EntryInput, EntryQuery, QueryResult } from '../types';
import { KnowledgeEntry, Prisma } from '../generated/prisma/client';

// ─── Read ────────────────────────────────────────────────────────────────────

export async function findEntry(query: EntryQuery): Promise<KnowledgeEntry | null> {
    return prisma.knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: query.entityType,
                entityId: query.entityId,
                key: query.key,
            },
        },
    });
}

export async function queryEntry(query: EntryQuery): Promise<QueryResult> {
    const entry = await findEntry(query);

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
    entityId: string
): Promise<KnowledgeEntry[]> {
    return prisma.knowledgeEntry.findMany({
        where: { entityType, entityId },
    });
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function createEntry(input: EntryInput): Promise<KnowledgeEntry> {
    return prisma.knowledgeEntry.create({
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
    updates: Partial<EntryInput>
): Promise<KnowledgeEntry> {
    const { valueRaw, conflictLog, ...rest } = updates;

    return prisma.knowledgeEntry.update({
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

export async function archiveEntry(
    entry: KnowledgeEntry,
    reason: 'superseded' | 'contradicted' | 'expired' | 'duplicate',
    supersededBy?: number
): Promise<void> {
    await prisma.$transaction([
        prisma.archive.create({
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
                supersededBy: supersededBy ?? null,
            },
        }),
        prisma.knowledgeEntry.update({
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
const STAFF_WRITERS = ['seed', 'archivist', 'attendant'];

export async function isProtectedEntry(query: EntryQuery): Promise<boolean> {
    const entry = await findEntry(query);
    return entry?.isProtected ?? false;
}

export function isStaffNamespace(entityType: string): boolean {
    return STAFF_NAMESPACES.includes(entityType);
}

export function canWriteToStaffNamespace(createdBy: string, entityType: string, key?: string): boolean {
    if (!isStaffNamespace(entityType)) return true;
    if (STAFF_WRITERS.includes(createdBy)) return true;
    // Allow agents to write their own attendant_state only
    if (entityType === 'agent' && key === 'attendant_state') return true;
    return false;
}