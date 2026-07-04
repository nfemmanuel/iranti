# PRD: CORE-16 — Semantic Retrieval Tier (Embeddings, Bottom Rung)

**Status:** proposed
**Phase:** CORE-16 (Phase 3 completion) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** backlog CORE-16 (pgvector scaffolding shipped, hybrid path deferred), AX-5 (exact-first tier), Layer 0c/0d/0f §9s (the disclosed paraphrase ceiling this closes), AX-2 (regime-signature versioning pattern this reuses), master PRD principles (near-perfect recall first; exact-lookup preference; transparent/auditable). NF rulings 2026-07-04: embeddings-first over extraction-LLM; public model + iranti-tailored system; thesis reconciliation = bottom-rung + version-lock + label.

---

## 1. Summary

Add the third retrieval rung: when exact-key and keyword tiers produce nothing (or too little) for a query, embed the query and cosine-match it against pre-computed fact embeddings — closing the measured paraphrase/alias miss class ("the figma file" vs a URL; reworded corrections) that every Layer-0 PRD §9 disclosed as the lexical ceiling. Strictly subordinate to the deterministic tiers, version-locked for reproducibility, provenance-labeled so a similarity hit is never mistaken for an exact one, and OFF until an embedder is configured.

## 2. Problem & motivation

The dogfood recall-plateau enumeration showed the remaining misses are dominated by meaning-vs-wording gaps that no lexical rule can close (6 alias-class, 2 correction-phrasing, 2 verb-phrasing of 11). falsePositiveRate's 75% residual is the same ceiling from the inverse direction. Embeddings attack exactly this class, with a safe failure mode: retrieval is read-only — a bad match surfaces an irrelevant-but-real fact, it cannot fabricate.

## 3. Goals & non-goals

**Goals**
- `EmbedderBackend` interface (mirrors `ExtractorBackend`/`GraphBackend` precedent): `embed(texts: string[]): Promise<number[][]>` + an identity descriptor `{provider, model, dim, version}`.
- Two backends at ship: `OllamaEmbedder` (OpenAI-compatible /embeddings endpoint, e.g. nomic-embed-text) and `NoopEmbedder` (tier off). Selected by env (`IRANTI_EMBEDDER=off|ollama`, default **off**).
- Write-side: fire-and-forget embedding of facts on write (key + value composed into one embed-text), stored in the existing `facts.embedding` column; on PGlite (column is text) store the JSON-serialized vector; on Postgres+pgvector store native. Backfill helper embeds un-embedded facts lazily at read or via a maintenance call.
- Read-side: AFTER exact/keyword scoring, if the deterministic tiers yield fewer than the per-entity cap AND an embedder is active: embed the query and JS-cosine against **the semantic tier's OWN candidate fetch** — NOT the keyword path's pool. **(PRD-review BLOCKER fix — the design trap the review confirmed:** `readRelevantFactsWithMatch` fetches `min(limit*3, 50)` rows ordered by `updatedAt DESC` (facts.ts:661/670) — a recency window built for keyword scoring. Reusing it would silently starve the semantic tier: an old-but-semantically-right fact outside the 50 most-recent never enters the pool, which defeats the entire paraphrase-closing purpose.) The semantic fetch: all non-archived, non-transient, embedded facts for the entity in scope, deterministic `id` ordering, hard cap 500 with a logged truncation note (Layer-0 scale is tens-to-hundreds; the cap is a guardrail, and its trigger is the named ANN-index escalation point). Admit above-floor hits into the REMAINING slots only — never displacing a deterministic hit, never granting `matched: true` (a new `semantic: true` label instead, additive response field).
- **Version lock (the determinism reconciliation):** every stored vector records `{model, version, dim}` (metadata or parallel column-in-metadata); vectors from a different regime are treated as absent (re-embed), mirroring AX-2's regime signature. Same text + same pinned model ⇒ same vector ⇒ reproducible retrieval.
- Bench: a SEPARATE `pnpm bench:semantic` mode (embedder required, deterministic given the pinned local model) scoring the previously-disclosed paraphrase probes; the default `pnpm bench` stays embedder-free and byte-deterministic exactly as today. Efficacy gate: the disclosed alias-paraphrase probe (`the-sync-wiki-page` class) and falsePositiveRate residual measured before/after in the semantic mode.

**Non-goals**
- Replacing or re-weighting the exact/keyword tiers (AX-5's exact-first contract is strengthened, not touched).
- pgvector/HNSW on the embedded engine (JS cosine over per-entity candidate sets is O(n) on tens-to-hundreds of facts — fine at Layer-0 scale; index escalation is a named follow-up with a scale trigger, e.g. >5k facts per project).
- transformers.js/ONNX bundled local embedder (adds a heavy dependency to the zero-infra core; named follow-up if Ollama-for-embeddings proves too much friction).
- Embedding rules, media descriptions, or aliases (facts only in v1; each other surface is its own measured follow-up).

## 4. Scope

**In:** `src/embed/` (interface + 2 backends + cosine + regime signature), `writeFact` fire-and-forget embed hook (trackBackground — RULE-2 pattern), read-path semantic fill, response field `semantic`, env plumbing, unit + integration tests, `bench:semantic` runner + its own baseline file, docs for hosts.
**Out (deferred, named):** ANN indexes, non-fact surfaces, bundled ONNX embedder, semantic tier for `iranti_search`/`iranti_query` (attend-only first, mirroring 0f's rollout).

## 5. Design decisions

- **D1 — Bottom rung, slot-fill only.** Deterministic hits always win their slots; semantic candidates only fill what remains empty. This is the thesis reconciliation NF ratified: determinism wherever it applies, similarity only where determinism structurally cannot reach. Rejected: score-blending (fuzzy influence over deterministic ranking — exactly what G1 forbids).
- **D2 — Fixed similarity floor, not tuned.** One conservative constant (start 0.60 cosine, pinned in code with rationale) — below it, return nothing rather than noise. Tuning-by-feel is the fuzzy slope; the constant only moves with a measured bench:semantic justification. (The floor's initial value is itself validated during build against the corpus and recorded in the build report.)
- **D3 — `semantic: true` label, never `matched: true`.** 0f's `matched` stays a *lexical* claim; hosts distinguish exact/keyword confirmation from semantic suggestion. Additive field; hosts ignoring it see today's behavior plus extra facts only when an embedder is on.
- **D4 — Regime-signature versioning (AX-2 pattern).** Model swap ⇒ old vectors invisible ⇒ no cross-model cosine (mathematically meaningless) and no silent drift. Re-embedding is lazy.
- **D5 — Off by default.** Zero-infra core stays zero-infra; enabling = setting `IRANTI_EMBEDDER=ollama` with Ollama present (the friction ladder NF is still deciding lives OUTSIDE this PRD).
- **D6 — Embed text = `key + ": " + value` clamped** — the key carries the categorical signal, the value the content; measured against alternatives during build only if the corpus shows a problem (no speculative tuning).

## 6. Schema / API changes

No migrations. `facts.embedding` (existing, dead) becomes live: native vector on Postgres, JSON-text on PGlite (engine-conditional serialization behind one accessor). `AttendResult.facts[]` gains optional `semantic?: boolean`. New env vars `IRANTI_EMBEDDER`, `IRANTI_EMBED_MODEL` (default nomic-embed-text), `IRANTI_EMBED_ENDPOINT`.

## 7. Acceptance criteria

- [x] Embedder off (default): byte-identical behavior to today; `pnpm bench` unchanged 0.0pp + deterministic ×2.
- [ ] Embedder on: the Layer-0c disclosed paraphrase probe class flips in `bench:semantic` — **NOT met by the shipped corpora as-is**: the 4 shipped personas' probes are lexical-keyword-shaped, not paraphrase-shaped, so the live `bench:semantic` run (28 positive probes) measured 0 semantic-only hits — a corpus-shape gap, not a code defect (the MockEmbedder integration tests DO prove the mechanism surfaces genuine paraphrases end-to-end, labeled `semantic:true`, never `matched:true`). Named follow-up: a dedicated paraphrase/alias probe corpus (changelog).
- [x] Deterministic tiers never displaced (adversarial test: semantic candidate with high cosine vs keyword hit — keyword keeps its slot/rank). Covered by `src/tests/semantic-retrieval.test.ts`.
- [x] Below-floor queries return no semantic facts (no-answer honesty preserved; negative probes in semantic mode gain no matched facts and falsePositiveRate does not regress).
- [x] Regime change invalidates old vectors (unit + integration); PGlite JSON-text round-trip covered directly (`src/tests/embed.test.ts`); Postgres's native-vector path shares the same accessor code but wasn't exercised against a live Postgres instance in this environment (house rule: no live server to open) — the shared-accessor design is the mitigation, not a live dual-engine run.
- [x] Cross-project isolation holds for semantic hits (adversarial: vectors never match across project scope).
- [x] Embed writes are trackBackground'd (teardown-race suite still green); tsc/lint 0; full suite green (508/510 — 2 pre-existing known failures, unrelated to CORE-16).

## 8. Deltas from master PRD

Implements the master's "third rung" (entity → keyword → vector) as long planned; the delta is DOCTRINAL and deliberate: vector is subordinated (slot-fill only) rather than a co-equal blended tier, per the exact-lookup-over-similarity principle NF re-ratified 2026-07-04.

## 9. Risks & open questions

- **Ollama-for-embeddings reintroduces the install-friction question** at a smaller scale (embedding models are ~250MB, no GPU need). Accepted for v1 because the tier is opt-in; the bundled-ONNX follow-up is the named escape if friction data demands it.
- **JS cosine is O(candidates)** per query over the semantic tier's own fetch (≤500/entity) — fine at current scale; the 500-cap truncation log is the measured signal for the ANN-index escalation (D-nongoal). (Replaces the draft's incorrect framing that treated cost as the only issue — the review proved the real issue was pool starvation, fixed above.)
- **Env-name disambiguation (review nit):** schema.ts/connection.ts comments reference a never-wired `IRANTI_EMBEDDINGS` placeholder; this PRD's `IRANTI_EMBEDDER` supersedes it — the build updates those two comments so the names can't be mistaken for two toggles.
- **A semantic hit can still be topically-wrong** (safe failure: real fact, wrong relevance). The floor + label + slot-fill bound the blast radius; bench:semantic quantifies it (precision-of-semantic-hits metric printed from day one).
- **Determinism of the embedder itself** is pinned-model-dependent (Ollama CPU inference is deterministic for fixed model+version in practice; asserted by a repeat-embed test, and bench:semantic carries its own determinism check gated on the local model being present).

## Changelog
- 2026-07-04 — proposed (NF rulings: embeddings-first, public model + tailored system, bottom-rung reconciliation)
- 2026-07-04 — PRD review applied (verdict was REWORK on one BLOCKER): semantic tier gets its own candidate fetch (all embedded facts per entity, id-ordered, 500-cap) instead of reusing the keyword path's 50-row recency window — starvation trap closed at design time; IRANTI_EMBEDDINGS comment supersession noted.
- 2026-07-04 — implemented (`feat/v1-wave1`). Judgment calls / deviations, each below the bar of a re-review but recorded per the wave's execution rules:
  - **Regime signature placement:** stored in `facts.metadata.embedRegime` (a jsonb merge, mirroring AX-7's `withTransient`/AX-1's `withRawKey` pattern in `src/library/keys.ts`) rather than inside a JSON envelope in the vector column itself. Rationale: the PRD's `{sig, vec}` envelope example presumed one column shape; splitting sig into metadata lets `facts.embedding` stay a genuine `vector(768)` on Postgres (no envelope-unwrapping needed before `vector_cosine_ops`/HNSW could ever be used) while PGlite's text column holds a plain `JSON.stringify(number[])` — one accessor (`src/embed/vector-column.ts`), same shape reasoning, cleaner Postgres path. Regime mismatch still means "treated as absent, re-embed lazily" exactly as specified.
  - **Slot-fill ordering correction (found during test-writing, not a PRD gap):** `readRelevantFactsWithMatch`'s pre-existing keyword-scored branch pads `topScored` up to `limit` with ZERO-scoring facts (recency tiebreak) whenever total candidates are fewer than `limit` — this is old, pre-CORE-16 behavior. Left as-is, that padding would silently consume slots before semantic fill ever got a chance, reproducing (at the output-slot level) the exact "deterministic filler starves the tier that should be filling gaps" trap the review already fixed once at the candidate-POOL level. Fix: real (score > 0) hits are computed first and capped at `limit`; semantic fill then competes for whatever's left; only if semantic leaves slots open (embedder off, or nothing above the floor) does zero-score ambient padding fill the remainder — which is exactly the old behavior in the embedder-off case, so the byte-identical-when-off acceptance criterion holds. Verified directly: `pnpm bench` ×2, all 8 headline metrics 0.0pp vs baseline, `bench/latest.json` byte-identical across runs.
  - **`bench:semantic` scope:** built as the authorized minimal skeleton (`src/harness/semantic-bench.test.ts`, ~150 LOC) — detects a reachable embedder (`IRANTI_EMBED_ENDPOINT`/`IRANTI_EMBED_MODEL`, native `/api/embed` probe) and skips cleanly with a printed message when none is found; when reachable, runs the 4 shipped personas' existing positive probes through `attend()` and reports semantic-only-hit count + a bare semantic-precision count, writing `bench/baseline-semantic.json` only on an actual run (no diffing logic yet). **Named follow-up** (not built, per the PRD's own gold-plating guard): a dedicated paraphrase/alias probe corpus (the shipped 4 personas' probes are lexical-keyword-shaped, not paraphrase-shaped, so a live run against them is a weak signal by construction), baseline-diffing across runs, and a per-persona precision-of-semantic-hits breakdown.
  - **Live Ollama run performed** (house rules: optional, must not gate): `nomic-embed-text` was pulled locally and `bench:semantic` run end-to-end against it. Result: 28 positive probes, 4 semantic facts returned, 0 semantic-only hits, 0 precision hits — expected given the corpus-shape gap noted above (the shipped personas don't contain paraphrase-class probes), not a defect. Recorded in `bench/baseline-semantic.json` as the first-ever run.
  - **OpenAI-compatible `/v1/embeddings` fallback** implemented in `OllamaEmbedder` (falls back on a 404 from the native `/api/embed` route) — the PRD flagged this as "if trivial"; it was, so both are covered rather than documenting a gap.
  - **MockEmbedder** (`src/embed/mock.ts`): deterministic bag-of-character-trigrams pseudo-embedding, L2-normalized, so cosine similarity is a real (if weak) semantic-adjacency signal rather than random noise — required for the adversarial slot-fill tests (high-cosine-but-wrong vs genuinely-relevant) to be constructible at all with a fixed, CI-safe fixture.
  - **Similarity floor validated against the corpus during build** (D2's build-time check): 0.60 held as the shipped constant — the MockEmbedder fixtures in `src/tests/semantic-retrieval.test.ts` cross it only for genuinely related key/value/query trigram overlaps (~0.64–0.74 measured) and stay well below it for unrelated pairs; no evidence surfaced to move the constant. The live Ollama run didn't produce a large enough paraphrase-hit sample to independently re-validate the floor against a real model — deferred to the named paraphrase-corpus follow-up above.
  - Gate numbers: `pnpm typecheck` exit 0; `pnpm lint` exit 0; unit suite (`src/tests/embed.test.ts`) 22/22; integration suite (`src/tests/semantic-retrieval.test.ts`, MockEmbedder) 7/7; mandated regression set (facts/mcp-tools/semantic-extract/correction-supersession/aliases/volatility) 186/186; full suite 508/510 passing, the 2 failures matching the pre-existing known list exactly (extraction-cache cache-read-error case; write-edges.test.ts parallel-contention flake, confirmed passing in isolation) — neither touches CORE-16 code.
