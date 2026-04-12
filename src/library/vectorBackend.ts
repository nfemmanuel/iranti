/**
 * Vector backend interface for iranti's semantic search layer.
 *
 * Defines the `VectorBackend` contract that all vector store implementations
 * must satisfy. Concrete backends (pgvector, Chroma, Qdrant) live in
 * `backends/` and are selected at runtime by the `backends/index.ts` factory.
 *
 * The interface is intentionally minimal:
 *  - `upsert`          — insert or update a single vector with metadata
 *  - `delete`          — remove a vector by id
 *  - `search`          — nearest-neighbour query returning scored results
 *  - `listIndexedIds`  — paginated list of all indexed ids (used for consistency checks)
 *  - `ping`            — health check
 *
 * `VectorMutationDbClient` is a narrowed Prisma type (only `$executeRaw`)
 * so backends that write directly to a pg table can accept a transaction
 * client without pulling in the full `PrismaClient` interface.
 */

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

export type VectorConsistencyFilter = {
    entityType?: string;
    entityId?: string;
};

export interface VectorBackend {
    upsert(params: VectorUpsertParams, db?: VectorMutationDbClient): Promise<void>;
    delete(id: string, db?: VectorMutationDbClient): Promise<void>;
    listIndexedIds(filter?: VectorConsistencyFilter, pageSize?: number): Promise<string[]>;
    search(
        vector: number[],
        topK: number,
        filter?: Record<string, unknown>
    ): Promise<VectorSearchResult[]>;
    ping(): Promise<boolean>;
}
