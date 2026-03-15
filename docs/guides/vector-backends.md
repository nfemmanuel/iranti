# Vector Backends Guide

Iranti uses PostgreSQL + pgvector by default. You can optionally move only the vector-similarity portion of hybrid search to Qdrant or ChromaDB while keeping all KB, conflict, and temporal logic in PostgreSQL.

## Default Behavior

No extra configuration is required for the default backend:

```env
IRANTI_VECTOR_BACKEND=pgvector
```

This keeps embeddings in the `knowledge_base.embedding` column and uses PostgreSQL for both lexical and vector search.

## Available Backends

### `pgvector` (default)

```env
IRANTI_VECTOR_BACKEND=pgvector
```

Uses the existing `knowledge_base.embedding` column in PostgreSQL.

### `qdrant`

```env
IRANTI_VECTOR_BACKEND=qdrant
IRANTI_QDRANT_URL=http://localhost:6333
IRANTI_QDRANT_API_KEY=optional
IRANTI_QDRANT_COLLECTION=iranti_facts
```

Notes:

- `IRANTI_QDRANT_URL` is required
- collection defaults to `iranti_facts`
- Iranti talks to Qdrant over REST; no SDK is required

### `chroma`

```env
IRANTI_VECTOR_BACKEND=chroma
IRANTI_CHROMA_URL=http://localhost:8000
IRANTI_CHROMA_COLLECTION=iranti_facts
```

Optional advanced settings:

```env
IRANTI_CHROMA_TENANT=default_tenant
IRANTI_CHROMA_DATABASE=default_database
IRANTI_CHROMA_TOKEN=optional
```

## Switching Backends

Set `IRANTI_VECTOR_BACKEND` and restart the process:

```env
IRANTI_VECTOR_BACKEND=qdrant
```

Switching backends at runtime without a restart is not supported.

## Important Migration Note

Switching vector backends does not migrate existing embeddings automatically.

Recommended migration path:

1. change `IRANTI_VECTOR_BACKEND`
2. point Iranti at the new backend
3. re-ingest or rewrite facts so embeddings are populated in the new backend

The lexical half of hybrid search always stays in PostgreSQL regardless of the vector backend you choose.

## Doctor Integration

`iranti doctor` now reports:

- which vector backend is configured
- whether it is reachable
- the configured backend URL for Qdrant and ChromaDB

If the backend is unreachable, hybrid search falls back to lexical-only scoring instead of blocking the request.
