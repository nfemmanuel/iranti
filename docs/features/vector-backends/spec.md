# Vector Backends

## Overview
Vector backends make the embedding-search portion of Iranti pluggable while leaving the rest of the stack unchanged. PostgreSQL full-text search remains in place for lexical ranking; only vector similarity can move between pgvector, Qdrant, and ChromaDB.

## Inputs
| Input | Type | Description |
|---|---|---|
| `IRANTI_VECTOR_BACKEND` | `string` | Backend selector: `pgvector`, `qdrant`, or `chroma` |
| `IRANTI_QDRANT_URL` | `string` | Required when the backend is `qdrant` |
| `IRANTI_QDRANT_API_KEY` | `string` | Optional Qdrant API key |
| `IRANTI_QDRANT_COLLECTION` | `string` | Optional Qdrant collection name, default `iranti_facts` |
| `IRANTI_CHROMA_URL` | `string` | Chroma base URL, default `http://localhost:8000` |
| `IRANTI_CHROMA_COLLECTION` | `string` | Optional Chroma collection name, default `iranti_facts` |
| `IRANTI_CHROMA_TENANT` | `string` | Optional Chroma tenant override |
| `IRANTI_CHROMA_DATABASE` | `string` | Optional Chroma database override |
| `IRANTI_CHROMA_TOKEN` | `string` | Optional bearer token for Chroma |

## Outputs
| Output | Type | Description |
|---|---|---|
| Upserted embedding | Backend write | Stores the embedding for each KB row after successful create/update |
| Deleted embedding | Backend delete | Removes or nulls the embedding when a fact is archived |
| Vector search results | `VectorSearchResult[]` | Top-k vector matches with metadata used for hybrid reranking |
| Doctor status | CLI output | Reachability plus KB/vector consistency report for the selected backend |
| Consistency audit | `VectorIndexConsistencyReport` | Detects missing embeddings and orphaned external vector ids |
| Consistency repair | `VectorIndexRepairReport` | Re-populates missing embeddings and removes orphaned vector ids |

## Decision Tree / Flow
1. Build a vector backend from env config.
2. Default to pgvector when `IRANTI_VECTOR_BACKEND` is unset.
3. On KB create/update:
   1. compute embedding text from key + summary + value
   2. generate embedding
   3. call backend `upsert()`
4. On archive/delete:
   1. call backend `delete()`
   2. when the backend is `pgvector`, run the embedding mutation on the active DB client/transaction
   3. if vector deletion fails, abort the KB delete/archive mutation
   4. only remove the KB row after vector cleanup succeeds
5. On hybrid search:
   1. compute lexical candidates in PostgreSQL
   2. ask the configured backend for vector candidates
   3. union the candidate ids
   4. recompute lexical scores in PostgreSQL
   5. merge lexical and vector scores in the existing reranking logic
   6. if the backend is unreachable, fall back to lexical-only scoring
6. On reconciliation audit:
   1. list expected KB entry ids for the selected scope
   2. list indexed vector ids from the configured backend
   3. report missing ids (present in KB, absent from vector index)
   4. report orphaned ids (present in vector index, absent from KB)
7. On reconciliation repair:
   1. re-upsert missing KB entries into the vector backend
   2. delete orphaned vector ids from the backend
   3. re-run the audit to confirm consistency

## Edge Cases
- Unknown backend: throws immediately with a clear error naming the invalid value.
- Missing Qdrant URL: throws immediately when `qdrant` is selected.
- Unreachable backend: `iranti doctor` reports it, and hybrid search falls back to lexical-only scoring.
- Reachable but inconsistent backend: `iranti doctor` warns with missing/orphaned counts so drift is visible before hybrid-search quality degrades silently.
- Backend delete failure during archive/delete: the KB row is retained and the archive mutation fails rather than silently leaving stale external vectors behind.
- External vector drift: Iranti can now enumerate missing embeddings and orphaned vector ids and repair them without changing caller-facing write/query APIs.
- Validation DB without pgvector: pgvector-specific test is skipped rather than reported as a false pass.
- Switching backends: existing embeddings are not migrated automatically; re-ingest is required.

## Test Results
Validation performed during implementation:
- `npx tsc --noEmit`
- `npm run test:archive-vector-contracts`
- `npm run test:vector-backends`
  - factory validation: pass
  - Qdrant REST adapter: pass
  - Chroma REST adapter: pass
  - pgvector regression: skipped in local validation because the `5433` DB does not expose pgvector support

## Related
- [src/library/vectorBackend.ts](/c:/Users/NF/Documents/Projects/iranti/src/library/vectorBackend.ts)
- [src/library/backends/index.ts](/c:/Users/NF/Documents/Projects/iranti/src/library/backends/index.ts)
- [src/library/backends/pgvectorBackend.ts](/c:/Users/NF/Documents/Projects/iranti/src/library/backends/pgvectorBackend.ts)
- [src/library/backends/qdrantBackend.ts](/c:/Users/NF/Documents/Projects/iranti/src/library/backends/qdrantBackend.ts)
- [src/library/backends/chromaBackend.ts](/c:/Users/NF/Documents/Projects/iranti/src/library/backends/chromaBackend.ts)
- [src/library/queries.ts](/c:/Users/NF/Documents/Projects/iranti/src/library/queries.ts)
