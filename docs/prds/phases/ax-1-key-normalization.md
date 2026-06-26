# PRD: AX-1 — Key Normalization (`normalizeKey`)

**Status:** shipped
**Phase:** AX-1 (Extraction/Retrieval Hardening track) · **Date:** 2026-06-26 · **Author:** NF + Claude
**Related:** master PRD §7 (facts), [decision register](../../decisions/open-decisions.md) AX-1 + OD-1, [fact-storage spec](../../specs/memory-storage/fact-storage.md), deferred CORE-18 (EntityAlias)

---

## 1. Summary
Make fact **keys** canonical at the write/read boundary so the same concept always lands on the
same `(entity, key)` slot. Today the store keys on the **raw** key string, so `Research Focus`,
`researchFocus`, and `research-focus` become three independent rows that conflict-resolution can
never reconcile. `normalizeKey` is a pure, deterministic function applied at write, read, and the
extractor — the **keystone** that gives us store-layer determinism and reliable exact lookup,
which everything else in the AX track measures against.

## 2. Problem & motivation
OD-1 put an LLM in the extraction floor; an LLM emits free-form keys. Verified in the current code:
- `writeFact` builds the advisory lock key, the existence lookup (`eq(facts.key, input.key)`), and
  the `onConflictDoUpdate` target all from the **raw** `input.key` (`src/library/facts.ts:176,185,280`).
- `readFact`/`findFact` look up on the raw key (`facts.ts:343,377`); the unique constraint
  `facts_tenant_entity_key_uniq` is on the raw `(tenant, entityType, entityId, key)`.
- Only the **heuristic** extractor slugifies keys (`src/extract/index.ts:70`); the **LLM** extractor
  passes the key verbatim (`item.key.slice(0,80)`, `extract/index.ts:207`).

Result: spelling/case/separator variants of one concept survive as distinct facts; supersession and
exact lookup both silently fail. This is the load-bearing defect — without it, every downstream AX
gain (cache, retrieval tier, grounding) fragments into duplicates.

## 3. Goals & non-goals
**Goals**
- One canonical key per concept at the `(tenant, entity, key)` address.
- Exact-key lookup is reliable regardless of the spelling the caller/LLM used.
- A single shared `normalizeKey` used identically at producer, write, and read (no drift).
- Pure/deterministic — no model, no network; store-layer determinism per the stated principle.

**Non-goals**
- Entity-id aliasing (the deferred CORE-18 EntityAlias) — this is *keys* only.
- Value normalization — values still vary run-to-run; this canonicalizes the key dimension only.
- Semantic key merging beyond a small, conservative, opt-in synonym map (see Layer 2).

## 4. Scope
**In**
- `normalizeKey(rawKey): string` in a new shared module (`src/library/keys.ts`) imported by both the
  extractor and the storage boundary (one source of truth).
- Apply at the boundary: `writeFact` (advisory lock key, existence lookup, conflict target),
  `readFact`, `findFact`, `searchFacts` key matching, and the LLM extractor key path.
- Preserve the original key as `metadata.rawKey` for provenance/audit.
- One-time migration to normalize existing fact keys (dev store is small; collapse duplicates
  through the normal supersession path).

**Out (deferred)**
- Layer-2 synonym/alias table (`key_aliases`, versioned) — *designed here, off by default*; the
  table + seeding land only when the first real synonym pair is needed.
- Entity aliasing (CORE-18, later).

## 5. Design decisions & rationale
- **Two layers, only Layer 1 always-on.**
  - **Layer 1 (syntactic, always-on, safe):** split optional `category:` prefix; convert camelCase
    to `-` boundaries; lowercase; collapse runs of non-alphanumeric to a single `-`; trim stray `-`;
    reattach as `category:slug`. → `Research Focus`, `researchFocus`, `research_focus` all become
    `research-focus`. **Why:** case/separator collapse can never merge two genuinely distinct
    concepts, so it is risk-free.
  - **Layer 2 (synonym map, opt-in, conservative, versioned):** `employer`/`company`/`works-at` →
    one canonical key, consulted at write+read. **Why:** real synonyms need collapsing, but this can
    over-merge, so it is off by default, append-only, versioned, and every snap is logged.
  - *Rejected:* normalizing only producer-side (the heuristic does this) — it misses LLM/agent keys;
    the **boundary** is where the guarantee must live.
- **Normalize at the boundary, not just the producer.** Even a raw agent-supplied key collapses,
  because `writeFact`/`findFact`/`readFact` normalize internally. *Rejected:* trusting callers.
- **Single shared function.** The verifier flagged that if normalization drifts between call sites,
  exact match silently breaks — so producer, write, and read import the *same* `normalizeKey`.
- **Keep `rawKey` in metadata.** Cheap provenance; makes a bad Layer-2 merge auditable/reversible.

## 6. Schema / API changes
- **New:** `normalizeKey(rawKey: string): string` (`src/library/keys.ts`). Pure, no deps.
- **Changed (no schema migration):** `writeFact`/`readFact`/`findFact`/`searchFacts` normalize the key
  internally; `facts.metadata.rawKey` carries the original (jsonb, no DDL).
- **Optional (deferred):** `key_aliases(version, alias, canonical, created_at)` for Layer 2.
- **Data migration:** one Drizzle migration to rewrite existing `facts.key` (and `fact_archive.key`)
  to their normalized form, collapsing duplicates via supersession.

## 7. Acceptance criteria
- [ ] `normalizeKey` is pure with unit tests for case/separator/camelCase/prefix collapse **and**
      idempotency: `normalizeKey(normalizeKey(x)) === normalizeKey(x)`.
- [ ] Writing one concept under N spellings (`Research Focus`/`research_focus`/`researchFocus`/
      `research-focus`) yields **exactly 1 surviving row + N-1 supersede/archive events**, not N rows.
- [ ] Round-trip: write under `Research Focus`, read via `research-focus` → **hit**.
- [ ] Producer, write, and read use the **same** `normalizeKey` (single import); a test asserts
      producer-emitted keys already equal their normalized form.
- [ ] On the fixed 50-msg golden corpus (AX-6 harness): **distinct-keys-per-entity drops** and
      **conflict-detection hits rise** vs baseline, **AND recall does not regress** (precision *and*
      recall measured — the no-clutter / FM-aware rule).
- [ ] Layer-2 synonym map is off by default; when enabled it is versioned and every snap is logged.
- [ ] Full suite + `pnpm typecheck` + `pnpm lint` green; new migration applies cleanly.

## 8. Deltas from the master PRD
None in spirit — this strengthens master §7's fact addressing. It revives the *intent* of the
deferred CORE-18 (alias resolution) for the **key** dimension only; it is explicitly **not** full
EntityAlias.

## 9. Risks & open questions
- **Over-merge via Layer 2** (silent data loss). Mitigation: Layer 1 always-safe; Layer 2
  conservative/opt-in/versioned; `rawKey` retained for audit/reversal; log every snap.
- **camelCase edge cases** (acronyms, e.g. `HTTPSEndpoint`). Define the split rule explicitly and
  unit-test it; when ambiguous, prefer under-splitting (safer than wrong merges).
- **Migration surfaces conflicts.** Acceptable on the small dev store; for production later, prefer a
  staged migration or read-time fallback.
- **Open:** does Layer 2 overlap the deep cross-key conflict checker (`conflicts.ts`)? Keep Layer 2
  minimal to avoid double-handling.

## 10. Verification
- Unit: `normalizeKey` purity, idempotency, collapse rules, camelCase.
- Integration: N-spelling-collapse (1 survivor + N-1 archives); round-trip read; producer/boundary
  agreement.
- Golden corpus (extend `scripts/extraction-local-eval.mts` into the AX-6 gate): distinct-keys ↓,
  conflict-hits ↑, recall not regressed — reported before/after.
- `pnpm typecheck`, `pnpm lint`, full vitest green; migration smoke.

## Changelog
- 2026-06-26 — proposed
- 2026-06-26 — accepted (NF verbal: "begin implementing AX-1 and then rigorously test")
- 2026-06-26 — shipped: `src/library/keys.ts` (normalizeKey + withRawKey), boundary wiring in facts.ts (writeFact/readFact/findFact/searchFacts/getFactHistoryByKey), LLM extractor path in extract/index.ts, 36 unit tests (keys.test.ts), 6 integration tests added to facts.test.ts, data migration 0011_ax1_key_normalization.sql. All test fixtures updated. 245/246 green (1 pre-existing governs-edge async-timing flake, unrelated).
- 2026-06-26 — post-review hardening (high-effort code review, 3 finder agents): (1) migration SQL now splits camelCase in exact parity with TS normalizeKey — verified all 11 parity cases against the DB (prior version mis-normalized camelCase keys, a latent read-miss; empirically 0 live impact); (2) migration archives duplicate losers to fact_archive (under the survivor's fact_id, FK-safe) before deleting — honors the never-hard-delete invariant + §7 acceptance; (3) `normalizeKey` caps keys at 80 chars so write/read/both-extractors agree on long keys; (4) migration preserves existing `rawKey` via COALESCE (no provenance clobber); (5) writeFact rejects punctuation-only keys that normalize to "" + LLM extractor skips them. +7 tests (41 unit, 8 integration). 253/253 green. Migration dry-run executed against real data (rolled back), idempotent on the normalized store.
