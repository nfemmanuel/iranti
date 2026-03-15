import { VectorBackend, VectorSearchResult, VectorUpsertParams } from '../vectorBackend';

type ChromaConfig = {
    url: string;
    collection: string;
    tenant?: string;
    database?: string;
    token?: string;
};

function normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

export class ChromaBackend implements VectorBackend {
    private readonly baseUrl: string;
    private readonly collection: string;
    private readonly tenant: string;
    private readonly database: string;
    private readonly token?: string;
    private collectionId: string | null = null;

    constructor(config: ChromaConfig) {
        this.baseUrl = normalizeBaseUrl(config.url);
        this.collection = config.collection;
        this.tenant = config.tenant ?? 'default_tenant';
        this.database = config.database ?? 'default_database';
        this.token = config.token?.trim() || undefined;
    }

    private collectionsRoute(): string {
        return `/api/v2/tenants/${this.tenant}/databases/${this.database}/collections`;
    }

    private recordsRoute(collectionId: string): string {
        return `${this.collectionsRoute()}/${collectionId}`;
    }

    private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
        const response = await fetch(`${this.baseUrl}${route}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const text = await response.text();
        const payload = text ? JSON.parse(text) as T : null;
        if (!response.ok) {
            throw new Error(`Chroma request failed (${response.status}): ${text || response.statusText}`);
        }
        return payload as T;
    }

    private async ensureCollection(): Promise<string> {
        if (this.collectionId) {
            return this.collectionId;
        }

        const existing = await this.request<Array<{ id: string; name: string }>>('GET', this.collectionsRoute());
        const match = existing.find((collection) => collection.name === this.collection);
        if (match) {
            this.collectionId = match.id;
            return match.id;
        }

        const created = await this.request<{ id: string }>('POST', this.collectionsRoute(), {
            name: this.collection,
            metadata: {},
        });
        this.collectionId = created.id;
        return created.id;
    }

    async upsert(params: VectorUpsertParams): Promise<void> {
        const collectionId = await this.ensureCollection();
        await this.request('POST', `${this.recordsRoute(collectionId)}/upsert`, {
            ids: [params.id],
            embeddings: [params.vector],
            metadatas: [params.metadata],
            documents: [String(params.metadata.summary ?? `${params.metadata.key ?? 'fact'} embedding`)],
        });
    }

    async delete(id: string): Promise<void> {
        const collectionId = await this.ensureCollection();
        await this.request('POST', `${this.recordsRoute(collectionId)}/delete`, {
            ids: [id],
        });
    }

    async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
        const collectionId = await this.ensureCollection();
        const payload = await this.request<any>('POST', `${this.recordsRoute(collectionId)}/query`, {
            query_embeddings: [vector],
            n_results: Math.max(1, topK),
            where: filter ?? undefined,
            include: ['metadatas', 'distances'],
        });

        const metadatas: Array<Record<string, unknown>> = Array.isArray(payload?.metadatas?.[0]) ? payload.metadatas[0] : [];
        const distances: number[] = Array.isArray(payload?.distances?.[0]) ? payload.distances[0] : [];

        return metadatas.map((metadata, index) => ({
            entityType: String(metadata.entityType ?? ''),
            entityId: String(metadata.entityId ?? ''),
            key: String(metadata.key ?? ''),
            score: 1 - Number(distances[index] ?? 1),
            metadata,
        }));
    }

    async ping(): Promise<boolean> {
        try {
            await this.request('GET', this.collectionsRoute());
            return true;
        } catch {
            return false;
        }
    }
}
