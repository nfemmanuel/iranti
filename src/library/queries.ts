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
            conflictLog: [],
        },
    });
}

export async function updateEntry(
    query: EntryQuery,
    updates: Partial<EntryInput>
): Promise<KnowledgeEntry> {
    const { valueRaw, ...rest } = updates;

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
        prisma.knowledgeEntry.delete({
            where: { id: entry.id },
        }),
    ]);
}

// ─── Guards ──────────────────────────────────────────────────────────────────

export async function isProtectedEntry(query: EntryQuery): Promise<boolean> {
    const entry = await findEntry(query);
    return entry?.isProtected ?? false;
}