import { ChromaBackend } from './chromaBackend';
import { PgvectorBackend } from './pgvectorBackend';
import { QdrantBackend } from './qdrantBackend';
import { VectorBackend } from '../vectorBackend';

export type VectorBackendConfig = {
    vectorBackend?: string;
    qdrantUrl?: string;
    qdrantApiKey?: string;
    qdrantCollection?: string;
    chromaUrl?: string;
    chromaCollection?: string;
    chromaTenant?: string;
    chromaDatabase?: string;
    chromaToken?: string;
};

export function resolveVectorBackendName(config: VectorBackendConfig = {}): string {
    return (config.vectorBackend ?? process.env.IRANTI_VECTOR_BACKEND ?? 'pgvector').trim().toLowerCase();
}

export function createVectorBackend(config: VectorBackendConfig = {}): VectorBackend {
    const backend = resolveVectorBackendName(config);

    if (backend === 'pgvector') {
        return new PgvectorBackend();
    }

    if (backend === 'qdrant') {
        const url = config.qdrantUrl ?? process.env.IRANTI_QDRANT_URL;
        if (!url) {
            throw new Error('IRANTI_QDRANT_URL is required when IRANTI_VECTOR_BACKEND=qdrant.');
        }
        return new QdrantBackend({
            url,
            apiKey: config.qdrantApiKey ?? process.env.IRANTI_QDRANT_API_KEY,
            collection: config.qdrantCollection ?? process.env.IRANTI_QDRANT_COLLECTION ?? 'iranti_facts',
        });
    }

    if (backend === 'chroma') {
        const url = config.chromaUrl ?? process.env.IRANTI_CHROMA_URL ?? 'http://localhost:8000';
        return new ChromaBackend({
            url,
            collection: config.chromaCollection ?? process.env.IRANTI_CHROMA_COLLECTION ?? 'iranti_facts',
            tenant: config.chromaTenant ?? process.env.IRANTI_CHROMA_TENANT,
            database: config.chromaDatabase ?? process.env.IRANTI_CHROMA_DATABASE,
            token: config.chromaToken ?? process.env.IRANTI_CHROMA_TOKEN,
        });
    }

    throw new Error(`Unknown IRANTI_VECTOR_BACKEND "${backend}". Use pgvector, qdrant, or chroma.`);
}
