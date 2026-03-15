import { Prisma } from '../../generated/prisma/client';
import { getDb } from '../client';
import { toPgVectorLiteral } from '../embeddings';
import { VectorBackend, VectorSearchResult, VectorUpsertParams } from '../vectorBackend';

let vectorSupportCache: boolean | null = null;

function isVectorRuntimeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
        message.includes('type "vector" does not exist') ||
        message.includes('operator does not exist: vector') ||
        message.includes('column "embedding" does not exist')
    );
}

async function hasVectorSupport(): Promise<boolean> {
    if (vectorSupportCache !== null) {
        return vectorSupportCache;
    }

    try {
        const rows = await getDb().$queryRaw<Array<{ has_vector: boolean; has_embedding: boolean }>>(Prisma.sql`
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

function buildFilters(filter?: Record<string, unknown>): Prisma.Sql[] {
    const filters: Prisma.Sql[] = [Prisma.sql`kb."isProtected" = false`];
    if (typeof filter?.entityType === 'string' && filter.entityType.length > 0) {
        filters.push(Prisma.sql`kb."entityType" = ${filter.entityType}`);
    }
    if (typeof filter?.entityId === 'string' && filter.entityId.length > 0) {
        filters.push(Prisma.sql`kb."entityId" = ${filter.entityId}`);
    }
    return filters;
}

export class PgvectorBackend implements VectorBackend {
    async upsert(params: VectorUpsertParams): Promise<void> {
        if (!(await hasVectorSupport())) {
            return;
        }

        try {
            const vectorLiteral = toPgVectorLiteral(params.vector);
            await getDb().$executeRaw(Prisma.sql`
                UPDATE "knowledge_base"
                SET "embedding" = ${vectorLiteral}::vector
                WHERE "id" = ${Number.parseInt(params.id, 10)}
            `);
        } catch (error) {
            if (isVectorRuntimeError(error)) {
                vectorSupportCache = false;
                return;
            }
            throw error;
        }
    }

    async delete(id: string): Promise<void> {
        if (!(await hasVectorSupport())) {
            return;
        }

        try {
            await getDb().$executeRaw(Prisma.sql`
                UPDATE "knowledge_base"
                SET "embedding" = NULL
                WHERE "id" = ${Number.parseInt(id, 10)}
            `);
        } catch (error) {
            if (isVectorRuntimeError(error)) {
                vectorSupportCache = false;
                return;
            }
            throw error;
        }
    }

    async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
        if (!(await hasVectorSupport())) {
            return [];
        }

        try {
            const vectorLiteral = toPgVectorLiteral(vector);
            const filters = buildFilters(filter);
            const rows = await getDb().$queryRaw<Array<{
                id: number;
                entityType: string;
                entityId: string;
                key: string;
                score: number | string | null;
            }>>(Prisma.sql`
                SELECT
                    kb."id",
                    kb."entityType",
                    kb."entityId",
                    kb."key",
                    (1 - (kb."embedding" <=> ${vectorLiteral}::vector)) AS "score"
                FROM "knowledge_base" kb
                WHERE ${Prisma.join(filters, ' AND ')}
                  AND kb."embedding" IS NOT NULL
                ORDER BY kb."embedding" <=> ${vectorLiteral}::vector ASC
                LIMIT ${Math.max(1, topK)}
            `);

            return rows.map((row) => ({
                entityType: row.entityType,
                entityId: row.entityId,
                key: row.key,
                score: Number(row.score ?? 0),
                metadata: { id: row.id },
            }));
        } catch (error) {
            if (isVectorRuntimeError(error)) {
                vectorSupportCache = false;
                return [];
            }
            throw error;
        }
    }

    ping(): Promise<boolean> {
        return hasVectorSupport();
    }
}
