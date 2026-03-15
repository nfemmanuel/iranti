import { EMBEDDING_DIMENSIONS } from '../embeddings';
import { VectorBackend, VectorSearchResult, VectorUpsertParams } from '../vectorBackend';

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

    async upsert(params: VectorUpsertParams): Promise<void> {
        await this.ensureCollection();
        await this.request('PUT', `/collections/${this.collection}/points`, {
            points: [{
                id: params.id,
                vector: params.vector,
                payload: params.metadata,
            }],
        });
    }

    async delete(id: string): Promise<void> {
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

    async ping(): Promise<boolean> {
        try {
            await this.request('GET', '/collections');
            return true;
        } catch {
            return false;
        }
    }
}
