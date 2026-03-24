import { PrismaClient } from '../generated/prisma/client';

export interface VectorSearchResult {
    entityType: string;
    entityId: string;
    key: string;
    score: number;
    metadata: Record<string, unknown>;
}

export interface VectorUpsertParams {
    id: string;
    vector: number[];
    metadata: Record<string, unknown>;
}

export type VectorMutationDbClient = Pick<PrismaClient, '$executeRaw'>;

export interface VectorBackend {
    upsert(params: VectorUpsertParams, db?: VectorMutationDbClient): Promise<void>;
    delete(id: string, db?: VectorMutationDbClient): Promise<void>;
    search(
        vector: number[],
        topK: number,
        filter?: Record<string, unknown>
    ): Promise<VectorSearchResult[]>;
    ping(): Promise<boolean>;
}
