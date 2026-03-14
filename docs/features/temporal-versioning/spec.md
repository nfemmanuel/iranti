# Temporal Versioning

## Overview
Iranti now tracks valid-time intervals for current and archived facts so callers can query current truth, ask for point-in-time truth with `asOf`, and inspect a fact's interval history. `knowledge_base` remains the current-truth surface while `archive` stores closed or contested intervals.

## Inputs
| Input | Type | Description |
|---|---|---|
| `validFrom` | `Date \| string \| undefined` | Optional timestamp for when an accepted fact became true/current. Rejected if it is in the future. |
| `asOf` | `Date \| string \| undefined` | Optional point-in-time filter for exact queries. |
| `includeContested` | `boolean` | Whether `contradicted` and `escalated` archive rows participate in temporal queries. Default `true`. |
| `includeExpired` | `boolean` | Whether `expired` archive rows participate in temporal queries. Default `false`. |

## Outputs
| Output | Type | Description |
|---|---|---|
| `query()` | `QueryResult` | Current fact, or point-in-time fact when `asOf` is provided. Includes `validFrom`, `validUntil`, archive metadata, and `contested`. |
| `history()` | `HistoryEntry[]` | Ordered valid-time history for one `(entity, key)` including current row if it exists. |
| `archive` row metadata | enums + timestamps | `archivedReason`, `resolutionState`, and `resolutionOutcome` distinguish closed, superseded, contradicted, escalated, and expired intervals. |

## Decision Tree / Flow
1. On a clean write, insert a new current row with `validFrom` and open-ended `validUntil = NULL`.
2. On supersession, archive the current row as `superseded`, delete it from `knowledge_base`, then insert the replacement current row.
3. On challenger-win contradiction, archive the current row as `contradicted`, delete it from `knowledge_base`, then insert the challenger as current.
4. On challenger-loss contradiction, keep the current row untouched and record the rejected challenger only in conflict/audit paths.
5. On unresolved escalation, archive two intervals:
   - a closed uncontested interval as `segment_closed`
   - a pending contested interval as `escalated`
6. During escalation, remove the current row from `knowledge_base`.
7. On escalation resolution, close the pending `escalated` archive row and reinsert current truth with `validFrom = resolution timestamp`.
8. `query(entity, key)` reads only `knowledge_base`.
9. `query(entity, key, { asOf })` checks `knowledge_base` first and falls back to `archive` only when no current row covers the timestamp.
10. `history(entity, key)` returns ordered archive intervals plus the current row, excluding `expired` by default.

## Edge Cases
- Future `validFrom` is rejected.
- Pending escalation rows keep `validUntil = NULL` until resolution closes them.
- Rejected challengers do not enter temporal history.
- Rejected challengers remain in conflict/audit traces only; they are intentionally excluded from `archive` in this MVP.
- `expired` rows are excluded from `asOf` and `history()` unless explicitly requested.
- A resolved escalation that restores the original fact starts a new current interval at resolution time; it does not reuse the pre-escalation `validFrom`.

## Test Results
- `npm run build` — PASS
- `npm run test:contracts` — PASS
- Direct DB migration verification is currently blocked by the local PostgreSQL instance reporting `FATAL: sorry, too many clients already`, so end-to-end DB-backed tests were not completed in this pass.

## Related
- `prisma/schema.prisma`
- `src/librarian/index.ts`
- `src/library/queries.ts`
- `src/sdk/index.ts`
- `src/api/routes/knowledge.ts`
