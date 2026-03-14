# Ingest Chunking

## Overview
Iranti's `ingest()` path is a single-entity preprocessing flow for raw text. The caller provides the target entity and a text blob, the chunker extracts candidate `key + value + summary + confidence` facts for that entity, and each fact is written through the normal Librarian pipeline. `ingest()` is additive and opt-in; explicit `write()` remains the primary interface.

## Inputs

| Input | Type | Description |
|---|---|---|
| `entityType` | `string` | Canonical entity type for the caller-supplied entity. |
| `entityId` | `string` | Canonical entity ID for the caller-supplied entity. |
| `rawContent` | `string` | Raw text to extract facts from. |
| `source` | `string` | Original source label preserved for source reliability scoring. |
| `confidence` | `number` | Caller confidence blended with per-fact extraction confidence. |
| `createdBy` | `string` | Agent or system performing the ingest. |

## Outputs

| Output | Type | Description |
|---|---|---|
| `extractedCandidates` | `number` | Number of JSON items returned by the extractor before validation. |
| `written` | `number` | Facts that were created or updated after Librarian handling. |
| `rejected` | `number` | Facts rejected by existing conflict logic. |
| `escalated` | `number` | Facts escalated for human resolution. |
| `skippedMalformed` | `number` | Extracted items discarded for missing required fields. |
| `reason` | `string \| undefined` | Parse/no-facts explanation when nothing usable is written. |
| `results` | `Array<{ key, action, reason }>` | Per-fact Librarian outcomes. |

## Decision Tree / Flow
1. SDK `ingest()` parses the caller entity and forwards the request to `librarianIngest()`.
2. `chunkContent()` calls the routed `extraction` model with a prompt scoped to exactly one entity.
3. The extractor must output a JSON array of objects containing `key`, `value`, `summary`, and `confidence`.
4. Invalid or malformed items are skipped; parse failure returns zero writes with a reason.
5. For each valid extracted fact:
   - the target entity stays caller-supplied
   - confidence is blended from extractor confidence and caller confidence
   - source stays the original source label
   - ingest provenance is attached in `properties.ingest`
6. Each fact is written through `librarianWrite()` so normal conflict handling, escalation, and source weighting still apply.
7. `librarianIngest()` returns aggregate counts plus per-fact outcomes.

## Edge Cases
- No usable facts: returns zero writes with `reason = "No facts extracted"`.
- Malformed JSON from the extractor: returns zero writes with a parse-failure reason; caller flow does not crash.
- Mixed explicit and implied facts: implied facts receive lower per-fact confidence than directly stated facts.
- Conflicting extracted fact: handled by the existing Librarian conflict path; ingest does not bypass write semantics.
- Provenance: extracted facts keep the original `source` for reliability scoring and attach extraction metadata in `properties.ingest`.

## Test Results
Validated by `npm run test:ingest` with the mock provider.

Covered cases:
- happy path with three retrievable facts
- direct facts scoring above implied facts
- no-usable-facts returning zero writes cleanly
- contradiction against an existing KB fact routing through Librarian conflict handling

## Related
- [chunker.ts](/c:/Users/NF/Documents/Projects/iranti/src/librarian/chunker.ts)
- [index.ts](/c:/Users/NF/Documents/Projects/iranti/src/librarian/index.ts)
- [index.ts](/c:/Users/NF/Documents/Projects/iranti/src/sdk/index.ts)
- [run_ingest_tests.ts](/c:/Users/NF/Documents/Projects/iranti/tests/ingest/run_ingest_tests.ts)
