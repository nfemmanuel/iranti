/**
 * Qdrant vector backend for iranti.
 *
 * Implements the `VectorBackend` interface against a Qdrant HTTP API server.
 * Suitable for deployments that need high-throughput vector search separate
 * from the primary Postgres database.
 *
 * Configuration (via `QdrantConfig` or env vars in the factory):
 *  - `url`        — Qdrant server base URL (e.g. http://localhost:6333)
 *  - `apiKey`     — optional API key header (`api-key`)
 *  - `collection` — collection name (default: iranti_facts)
 *
 * The collection is created lazily on the first upsert with `EMBEDDING_DIMENSIONS`
 * dimensions and cosine distance. Subsequent calls skip collection creation
 * via the `collectionReady` flag.
 */

import { EMBEDDING_DIMENSIONS } from '../embeddings';
import { VectorBackend, VectorConsistencyFilter, VectorMutationDbClient, VectorSearchResult, VectorUpsertParams } from '../vectorBackend';

type QdrantConfig = {
    url: string;
    apiKey?: string;
    collection: string;
};

function normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

function qdrantFilter(filter?: Record<string, unknown>): Record<string, unknown> | undefined {
    const must: Array<Record<string, unknown>> = [];
    if (typeof filter?.entityType === 'string' && filter.entityType.length > 0) {
        must.push({ key: 'entityType', match: { value: filter.entityType } });
    }
    if (typeof filter?.entityId === 'string' && filter.entityId.length > 0) {
        must.push({ key: 'entityId', match: { value: filter.entityId } });
    }
    return must.length > 0 ? { must } : undefined;
}

export class QdrantBackend implements VectorBackend {
    private readonly baseUrl: string;
    private readonly apiKey?: string;
    private readonly collection: string;
    private collectionReady = false;

    constructor(config: QdrantConfig) {
        this.baseUrl = normalizeBaseUrl(config.url);
        this.apiKey = config.apiKey?.trim() || undefined;
        this.collection = config.collection;
    }

    private async request<T>(method: string, route: string, body?: unknown, allow404 = false): Promise<T | null> {
        const response = await fetch(`${this.baseUrl}${route}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (allow404 && response.status === 404) {
            return null;
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Qdrant request failed (${response.status}): ${text || response.statusText}`);
        }

        const text = await response.text();
        return text ? JSON.parse(text) as T : null;
    }

    private async ensureCollection(): Promise<void> {
        if (this.collectionReady) {
            return;
        }

        const existing = await this.request('GET', `/collections/${this.collection}`, undefined, true);
        if (!existing) {
            await this.request('PUT', `/collections/${this.collection}`, {
                vectors: {
                    size: EMBEDDING_DIMENSIONS,
                    distance: 'Cosine',
                },
            });
        }
        this.collectionReady = true;
    }

    async upsert(params: VectorUpsertParams, _db?: VectorMutationDbClient): Promise<void> {
        await this.ensureCollection();
        await this.request('PUT', `/collections/${this.collection}/points`, {
            points: [{
                id: params.id,
                vector: params.vector,
                payload: params.metadata,
            }],
        });
    }

    async delete(id: string, _db?: VectorMutationDbClient): Promise<void> {
        await this.ensureCollection();
        await this.request('POST', `/collections/${this.collection}/points/delete`, {
            points: [id],
        });
    }

    async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
        await this.ensureCollection();
        const payload = await this.request<any>('POST', `/collections/${this.collection}/points/query`, {
            query: vector,
            limit: Math.max(1, topK),
            with_payload: true,
            filter: qdrantFilter(filter),
        });

        const points = Array.isArray(payload?.result?.points)
            ? payload.result.points
            : Array.isArray(payload?.result)
                ? payload.result
                : [];

        return points.map((point: any) => ({
            entityType: String(point.payload?.entityType ?? ''),
            entityId: String(point.payload?.entityId ?? ''),
            key: String(point.payload?.key ?? ''),
            score: Number(point.score ?? 0),
            metadata: point.payload ?? {},
        }));
    }

    async listIndexedIds(filter?: VectorConsistencyFilter, pageSize: number = 256): Promise<string[]> {
        await this.ensureCollection();
        const ids: string[] = [];
        let offset: string | number | null | undefined = undefined;

        while (true) {
            const payload: any = await this.request<any>('POST', `/collections/${this.collection}/points/scroll`, {
                limit: Math.max(1, pageSize),
                offset,
                with_payload: true,
                with_vector: false,
                filter: qdrantFilter(filter),
            });

            const points = Array.isArray(payload?.result?.points)
                ? payload.result.points
                : Array.isArray(payload?.result)
                    ? payload.result
                    : [];

            ids.push(...points.map((point: any) => String(point.id)));

            const nextOffset: string | number | null | undefined = payload?.result?.next_page_offset;
            if (!nextOffset || points.length < Math.max(1, pageSize)) {
                break;
            }
            offset = nextOffset;
        }

        return ids;
    }

    async ping(): Promise<boolean> {
        try {
            await this.request('GET', '/collections');
            return true;
        } catch {
            return false;
        }
    }
}
