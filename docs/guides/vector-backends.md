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

The API runtime also keeps probing the configured backend after startup. `/health` exposes the latest probe result under `checks.vectorBackend`, and `operatorStatus` degrades when the configured backend stops responding.

## Detecting and Repairing Drift

Iranti now exposes library-level reconciliation helpers for vector drift:

- `auditVectorIndexConsistency(...)`
- `repairVectorIndexConsistency(...)`

These helpers detect:

- missing embeddings: facts present in `knowledge_base` but absent from the configured vector backend
- orphaned vector ids: vectors present in the configured backend but absent from `knowledge_base`

Example from the repo root:

```ts
import { auditVectorIndexConsistency, repairVectorIndexConsistency } from './src/library/queries';

const audit = await auditVectorIndexConsistency();
console.log(audit);

if (!audit.consistent) {
  const repaired = await repairVectorIndexConsistency();
  console.log(repaired);
}
```

Notes:

- pgvector audits compare KB rows against non-null `knowledge_base.embedding` values.
- Qdrant and Chroma audits enumerate indexed ids through their REST APIs.
- Repair keeps public read/write behavior backward compatible; it only reconciles backend state.
- `iranti doctor` covers reachability, while the API `/health` surface covers ongoing post-start monitoring.
