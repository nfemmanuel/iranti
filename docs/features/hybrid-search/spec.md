# Hybrid Search

## Overview
Hybrid search adds ranked fact discovery when exact keys are unknown by combining lexical full-text ranking and vector similarity against `knowledge_base` entries.

## Inputs
| Input | Type | Description |
|---|---|---|
| query | string | Natural language search phrase. |
| limit | number | Max results (default 10, max 50). |
| entityType | string? | Optional entity type filter. |
| entityId | string? | Optional entity id filter. |
| lexicalWeight | number? | Relative weight for full-text rank (0 to 1). |
| vectorWeight | number? | Relative weight for embedding similarity (0 to 1). |
| minScore | number? | Minimum hybrid score threshold (0 to 1). |

## Outputs
| Output | Type | Description |
|---|---|---|
| results | array | Ranked matching facts. |
| results[].entity | string | Canonical `entityType/entityId`. |
| results[].key | string | Fact key. |
| results[].value | unknown | Raw fact value. |
| results[].summary | string | Fact summary text. |
| results[].lexicalScore | number | Full-text component score. |
| results[].vectorScore | number | Vector component score. |
| results[].score | number | Final weighted score. |

## Decision Tree / Flow
1. Validate input and normalize weights.
2. Compute deterministic embedding for the query text.
3. If vector support is unavailable, compute a deterministic in-process semantic fallback by embedding the query and candidate fact text at read time.
4. If vector support is available, build lexical and vector candidate sets.
5. Score candidates with weighted lexical + vector formula.
6. Filter by `minScore`, drop zero-signal lexical rows, sort descending, and return top `limit`.

## Edge Cases
- Empty query: request is rejected.
- `lexicalWeight + vectorWeight <= 0`: request is rejected.
- Missing pgvector support at runtime: automatic in-process semantic fallback.
- Entries without embeddings: vector score contributes `0` for those rows.
- Protected entries: always excluded from results.
- External vector backends must store entity metadata (`entityType`, `entityId`, `key`) so filtered search can work correctly.

## Test Results
- TypeScript build passes with schema generation (`npm.cmd run build`).
- Hybrid route, SDK method, and query-layer compile successfully.

## Related
- `src/library/queries.ts`
- `src/library/embeddings.ts`
- `src/sdk/index.ts`
- `src/api/routes/knowledge.ts`
- `prisma/migrations/20260305000100_add_hybrid_search/migration.sql`
