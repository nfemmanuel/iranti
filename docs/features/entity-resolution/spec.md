# Entity Resolution

## Overview
Entity resolution introduces a canonical identity layer that maps variable entity mentions (for example `project/Atlas` and `project/project_atlas`) to a single canonical entity key before writes, reads, and observe-time retrieval.

## Inputs
| Input | Type | Description |
|---|---|---|
| `entityType` | `string` | Entity namespace (project, person, company, etc.). |
| `entityId` | `string` | Candidate entity ID from client/detector/extractor. |
| `rawName` | `string` | Human-readable mention text when available. |
| `aliases` | `string[]` | Additional aliases to link to canonical identity. |
| `createIfMissing` | `boolean` | Whether resolver can create canonical entity if none exists. |
| `source` | `string` | Origin of mapping request (`observe`, `write`, `query`, etc.). |
| `confidence` | `number` | Confidence score (0-100) for alias metadata. |

## Outputs
| Output | Type | Description |
|---|---|---|
| `entityType` | `string` | Canonical entity type used for storage/retrieval. |
| `entityId` | `string` | Canonical entity ID used for storage/retrieval. |
| `canonicalEntity` | `string` | Canonical key in `entityType/entityId` format. |
| `matchedBy` | `'exact' | 'alias' | 'created'` | How resolution succeeded. |
| `addedAliases` | `string[]` | New normalized aliases inserted during resolution. |

## Decision Tree / Flow
1. Normalize all candidate aliases consistently (case-fold, punctuation removal, underscore/space collapse, type prefix handling).
2. Check `entity_aliases` by `(entityType, aliasNorm)` for existing canonical mapping.
3. If alias hit exists, return mapped canonical entity and backfill missing aliases.
4. If no alias hit, check exact canonical entity existence in `entities`.
5. If exact entity missing, check existing KB rows for `(entityType, entityId)` to preserve backward compatibility with historical data.
6. If still unresolved and `createIfMissing=true`, create canonical entity in `entities` and seed aliases in `entity_aliases`.
7. If unresolved and `createIfMissing=false`, return resolution error.

## Edge Cases
- Empty or malformed entity strings are rejected early.
- Low-confidence detect candidates are dropped before resolution in `observe`.
- Aliases already mapped to another canonical entity are not re-pointed unless explicitly forced.
- Read paths (`query`, `queryAll`, `observe`) use `createIfMissing=false` to avoid KB pollution.
- Legacy string detector output remains accepted in `observe` as fallback candidates.

## Test Results
- `npx prisma migrate dev --name entity_resolution` applied successfully.
- `npx prisma generate` regenerated client with `Entity` and `EntityAlias` models.
- `npx tsc --noEmit` passes after resolver integration in `write/query/queryAll/observe`.

## Related
- `prisma/schema.prisma`
- `src/library/entity-resolution.ts`
- `src/sdk/index.ts`
- `src/attendant/AttendantInstance.ts`
- `src/api/routes/knowledge.ts`
