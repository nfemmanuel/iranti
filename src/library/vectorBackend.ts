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

export interface VectorBackend {
    upsert(params: VectorUpsertParams): Promise<void>;
    delete(id: string): Promise<void>;
    search(
        vector: number[],
        topK: number,
        filter?: Record<string, unknown>
    ): Promise<VectorSearchResult[]>;
    ping(): Promise<boolean>;
}
