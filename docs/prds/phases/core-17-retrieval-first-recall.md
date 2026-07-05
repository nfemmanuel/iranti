# PRD: CORE-17 — Retrieval-First Recall (semantic-primary for open queries + a reason-over truth layer)

**Status:** proposed
**Phase:** CORE-17 · **Date:** 2026-07-05 · **Author:** NF + Claude
**Branch:** `feat/core-17-retrieval-first` (off `feat/v1-wave1`)
**Related:** CORE-16 (semantic tier — this **revises its D1/D8 doctrine for the recall path only**), BENCH-1 (the harness that produced the evidence), `project/iranti/benchmark_chunkrag_longmemeval_n24` (chunk-RAG 79.2% n=24 vs frontier ~18% / heuristic 12.5% on the same 48-session haystacks), OD-1/OD-2 (extraction floor — reframed, not undone), AX-5 (exact-first), G1 (never-invent), master PRD (near-perfect recall first; exact-lookup preference; transparent/auditable).

---

## 1. Summary

The competitive benchmark proved iranti's recall ceiling is **retrieval, not extraction**. On ~48-session LongMemEval-S haystacks, extraction-based configs collapse — frontier **~18%**, heuristic **12.5%** — because iranti's default recall is *lexical*: the model extracts the right fact and then can't find it among hundreds when the question shares no words with the stored answer. Pure semantic retrieval over **raw chunks** scores **79.2% (n=24)** and ~100% on single-needle questions on the identical haystacks.

CORE-17 makes semantic recall the **primary** path for open, natural-language queries — **routed by query type** so exact-key lookup stays supreme wherever a key is known — embeds **raw conversation chunks** (not just terse `key: value` facts), and adds the **reason-over layer** (an abstention gate + aggregation hooks) that reclaims the exact categories pure retrieval structurally fails: counting, duration, and "not enough information."

It is the deliberate, **evidence-forced reversal of CORE-16's "vector = bottom-rung slot-fill" doctrine — for the recall path only.** CORE-16's determinism reconciliation (version-lock, `semantic:` label, exact-first for structured queries) is **kept intact** for the structured path. This PRD asks NF to explicitly re-ratify the 2026-07-04 "exact-lookup over similarity" ruling in light of the new benchmark evidence (see §8).

## 2. Problem & motivation

**Two independent axes.** Extraction = *what shape memory is stored in.* Retrieval = *how it's found again.* iranti invested heavily in the extraction axis (regex → local-LLM → frontier, OD-1/OD-2) and shipped the retrieval axis as *exact-key + lexical*, with CORE-16's semantic tier **off by default, bottom-rung, and over facts**. The benchmark shows this is the wrong allocation:

- **Lexical retrieval needs vocabulary overlap.** "why did I switch ORMs" shares no tokens with a stored `decision:orm = Drizzle`. On a large history this is fatal — the needle is present but unrankable. This is what caps frontier at 18%.
- **CORE-16's slot-fill never fires where it's needed.** Its design ("semantic fills only the slots the deterministic tiers leave empty") assumes the deterministic tiers first return *something rankable*. On a 48-session haystack of an open question, exact-key has no key and lexical has no overlap — so there are no deterministic hits to slot-fill *behind*, and the one tier that could find the answer is subordinated to tiers that found nothing.
- **CORE-16 embeds terse facts.** `decision:orm = Drizzle` carries thin semantic content; the *reasoning* ("Prisma migrations kept breaking") was compressed out at extraction, so even semantic matching against facts is weak. Raw chunks retain the reasoning and match by meaning.

**Failure taxonomy of the winner (chunk-RAG n=24, 5 failures of 24):** temporal/duration (`08f4fc43`), counting (`0bc8ad92`), multi-session disambiguation (`09ba9854`), **abstention** (`09ba9854_abs` — answered from the nearest plausible chunk instead of declining), and one empty answer (`0bc8ad93`). These are not retrieval misses — they are the jobs retrieval *structurally cannot do*: count, compute, and know-when-absent. Those are fact-layer / never-invent jobs. **79% is the retrieval-only ceiling; the structured layer is what reclaims the rest.**

## 3. Goals & non-goals

**Goals**
- **G1 — Query router.** Classify each read as **STRUCTURED** (known entity+key, correction, exact recall → exact-first tier, unchanged) or **OPEN** (natural-language recall → semantic-primary). Deterministic, rule-based, auditable; no LLM in the router v1.
- **G2 — Chunk store.** Embed and retrieve **raw conversation chunks** ("episodes"), not only facts. Reuse the CORE-16 `EmbedderBackend` + `vector-column` accessor; new chunk surface (table or chunk-typed entity).
- **G3 — Semantic-primary read for OPEN queries.** Cosine top-N over chunks feeds the reader directly — **not** slot-fill-behind-deterministic. Exact/lexical hits are *fused in* (G6), not gatekeepers.
- **G4 — Abstention gate (G1/never-invent as a retrieval-time gate).** If the top chunk is below the similarity floor **and** the fact layer has no matching entity, return **no-answer** rather than let the reader guess. Directly reclaims the abstention failure class.
- **G5 — Reason-over hooks.** Count/duration/aggregation questions resolved via the fact layer (compute over retrieved facts, or store derived facts), not raw chunk retrieval.
- **G6 — Fusion (v1-optional).** Reciprocal-rank-fuse semantic + lexical + exact for OPEN queries so exact-token needles (names, IDs, error codes) embeddings fuzz are still caught.
- **G7 — Bench-gated, test-first.** Every change measured on BENCH-1 (chunk-rag adapter + iranti-next, track H, LongMemEval-S + coding-continuity) before/after. Acceptance criteria (§7) are executable targets written **first** on this branch.

**Non-goals**
- Removing exact-first or CORE-16's structured path — **strengthened, not touched** (the exact-lookup contract holds for STRUCTURED queries).
- Cloud reranker / cloud reader / cloud embeddings in v1 — named escalation (§9); local/deterministic/free stays the default.
- ANN index on the embedded engine — JS cosine at personal scale; the escalation trigger (Postgres + pgvector/HNSW) is named, not built.
- Replacing PGlite — see D-STORAGE (PGlite stays; markdown is a projection, not the store).
- Reranker / HyDE / query-rewrite — the measured accuracy ladder past v1 (§5 D-LADDER), named not built.

## 4. Scope

**In:** query router; chunk store + write path; semantic-primary read for OPEN queries; abstention gate; aggregation hooks; RRF fusion (if it earns its complexity on the bench); bench wiring so iranti-next's *own* recall (not just the standalone adapter) is measured; unit + integration + bench tests written first.
**Out (deferred, named):** cross-encoder reranker (v2), HyDE/multi-query rewrite (v2), pgvector-in-PGlite investigation (v2), cloud escalation tier, chunk-decay/pruning policy (own follow-up, §9), non-chat surfaces (rules/media) as chunks.

## 5. Design decisions

- **D-STORAGE — PGlite stays the engine; markdown is a projection, not the store.** The redesign leans *harder* into vector similarity + exact fact rows + transactional corrections — exactly what a real embedded DB does and a markdown pile cannot (no vector index, no exact/filtered queries, no atomic corrections; you'd bolt a vector index + a fact index onto the files, i.e. rebuild a DB badly). Markdown's genuine strengths — human-readable, git-diffable, hand-editable — are properties of a **human interface**, not a query engine. Keep them as an **optional export/import view** projected *from* the DB. PGlite specifically buys real Postgres semantics + a clean opt-in path to server Postgres + pgvector/HNSW at scale — an upgrade path that matters now that vectors are primary. **Caveat carried into §9:** PGlite 0.5.3 as installed ships **no** pgvector, so embeddings are TEXT + JS cosine (O(n) over a 500-cap) — fine at personal scale, and the named escalation point when chunks grow.
- **D-ROUTE — route by query type; this is the reconciliation of exact-first with semantic-primary.** Determinism-*exact* where a key exists (STRUCTURED); determinism-*fuzzy* where it structurally cannot (OPEN). Exact-lookup is not demoted — it is *supreme on the path it was built for.* Semantic is primary only where there is no key to look up.
- **D-CHUNKS — embed raw chunks, not just facts.** The decisive variable in the benchmark. Facts stay (truth layer); chunks are added (recall layer).
- **D-PRIMARY — for OPEN queries, semantic is primary, not slot-fill.** Reverses CORE-16 D1/D8 **for the recall path only**. CORE-16 D2 (fixed floor), D3 (`semantic:` label ≠ `matched:`), D4 (regime version-lock), D5 (determinism) are all **retained**.
- **D-ABSTAIN — the similarity floor is an abstention gate, not just a noise filter.** Below floor + no fact hit ⇒ no-answer. This is G1/never-invent made first-class at retrieval time — and the one thing pure-semantic competitors provably cannot do.
- **D-FACTS-TRUTH — the fact layer remains the source of truth and the reason-over layer.** Counts, durations, corrections, and abstention are fact-layer jobs; chunks are recall, facts are truth.
- **D-LOCAL — local/deterministic/free stays the default.** Accuracy bets that break any of the three (cloud reranker/reader/embeddings) are opt-in escalations, reported separately so we always publish the within-principles number.
- **D-LADDER — the ranked accuracy roadmap (NF's "highest possible accuracy" question).** Sequenced by expected lift × cost, all but the last three within-principles:
  1. **Semantic-primary over chunks** (this PRD) — the proven 12–18% → ~79% jump. *Biggest single lever.*
  2. **Rerank** top-N cosine → cross-encoder → top-K (local `bge-reranker`, pinned/deterministic) — largest *incremental* RAG lift; improves what the reader sees. *(v2)*
  3. **Abstention gate** (this PRD) — reclaims the abstention class + kills confident-wrong answers.
  4. **Aggregation hooks** (this PRD) — reclaims counting/duration.
  5. **RRF fusion** semantic+lexical+exact — disambiguation + exact-token needles.
  6. **Chunk granularity + embedder quality** — finer/overlapping chunks, stronger local model; storage tradeoff.
  7. **HyDE / query-rewrite** (local LLM) — recall lift on terse/implicit queries; cost/determinism tradeoff. *(v2)*
  8. **Reader-prompt discipline** — answer-only-from-context + abstain; cheap polish.
  - **v1 = 1 + 3 + 4** (+ 5 if it earns its keep on the bench). 2, 6, 7 named for v2. The within-principles ceiling is ~1–6; breaking principles (cloud 2/7/embeddings) buys a few more points at the cost of local/deterministic/free — and we benchmark honestly, so both numbers get published.

## 6. Schema / API changes

- **Chunk store:** a `chunks`/`episodes` surface — raw text + embedding (reuse `vector-column` accessor: native `vector` on Postgres, JSON-text on PGlite) + provenance (session/turn/date) + regime signature (CORE-16 D4). Likely a table; a chunk-typed entity is the fallback if it avoids a migration. **To be finalized in build against the existing schema** (mirror CORE-16's "no needless migration" check).
- **Read path:** query router in `attend` (and later `search`); OPEN queries hit the chunk tier primary. `AttendResult` gains `chunks[]` alongside `facts[]`, and an explicit **abstention signal** when the floor gate fires.
- **Write path:** raw session chunk embedded fire-and-forget on write (trackBackground, RULE-2 pattern — same as CORE-16 fact embedding).
- **Env:** reuse `IRANTI_EMBEDDER` / `IRANTI_EMBED_MODEL` / `IRANTI_EMBED_ENDPOINT`. **Open question (§9):** the free tier's *recommended* config turns the recall embedder ON, but the zero-infra core default stays OFF — or we bundle a no-Ollama path. Decision deferred to §9.

## 7. Acceptance criteria (bench-gated, written test-first on this branch)

- [ ] **Recall parity inside iranti, not just the adapter:** iranti-next with CORE-17 on LongMemEval-S track H **≥ the chunk-rag adapter's 79.2% (n=24)**, vs the 12.5% / 18% baselines. (The point of the redesign is that iranti's *own* recall matches the concept test.)
- [ ] **Abstention reclaimed:** the abstention probes (`*_abs`) return no-answer via the floor gate (reclaim the `09ba9854_abs` class); `falsePositiveRate` does not regress.
- [ ] **Count/duration improved:** the counting (`0bc8ad92`) and duration (`08f4fc43`) probe classes improve via aggregation hooks vs raw chunk-only.
- [ ] **Structured path byte-identical:** exact-key / correction / STRUCTURED behavior unchanged; all CORE-16 acceptance criteria still hold; `pnpm bench` (embedder-off) 0.0pp × 2.
- [ ] **Determinism:** pinned model ⇒ reproducible retrieval × 2.
- [ ] **Zero-infra preserved:** embedder off ⇒ today's behavior exactly.
- [ ] Gates: `pnpm typecheck` 0, `pnpm lint` 0, full suite green (minus the 2 pre-existing known failures).

## 8. Deltas from CORE-16 / master PRD — **DECIDED (NF, 2026-07-05): re-ratified**

- **Reverses CORE-16 D1/D8 for the RECALL path** (semantic primary for OPEN queries, not slot-fill-behind-deterministic). **Retains** CORE-16 D2/D3/D4/D5. This is a doctrinal change to a ruling NF ratified 2026-07-04 ("exact-lookup over similarity"). **RATIFIED 2026-07-05 — NF clarified the original intent: vector was never meant to be OFF, only to take a *backseat to deterministic*. CORE-16 over-implemented "backseat" as off-by-default + bottom-rung + over-terse-facts. CORE-17 corrects it to the right mental model: deterministic *drives* (exact-first always wins when it has an answer); semantic *rides shotgun and takes the wheel* when deterministic can't see the road — open questions, and synonym/alias gaps where the key doesn't align.** **The reconciliation (D-ROUTE):** exact-lookup is not demoted — it stays supreme for STRUCTURED queries; semantic goes primary only for OPEN recall where no key exists. Both remain deterministic; they differ in exact-vs-fuzzy, routed by query type.
- **Reframes OD-1/OD-2:** extraction is the **truth / reason-over layer**, not the recall layer. The extraction floor decisions stand; their *job* is relabeled. Recall is now the chunk/semantic tier's responsibility.

## 9. Risks & open questions

- **Recall-embedder default — DECIDED 2026-07-05 (Claude's pick, per NF "take your pick"): default ON when an embedder is reachable (endpoint up AND embed model present via probe), else silent OFF with a one-time hint.** Rationale: best matches NF's "backseat, not off" intent for vector, and dovetails OD-2 (local Ollama is already the default runtime, so nomic-embed-text is reachable in the standard setup — vector recall is on out-of-the-box there; a no-Ollama user degrades silently to deterministic-only, i.e. today's zero-infra behavior, no crash). Rejected: default-OFF+opt-in (contradicts "backseat not off" — makes vector opt-IN, the exact thing we're undoing); bundle-ONNX-now (heavy dep on the zero-infra core; stays the named CORE-16 follow-up if Ollama friction proves real).
- **Chunk storage growth ⇒ decay/pruning.** Raw chunks are ~100× bulkier than facts (a session vs a 50-byte fact row). Needs a decay/pruning policy (Shodh's "decay curves" as real tooling, not marketing) to stay bounded. Own follow-up.
- **PGlite vector path at scale:** 0.5.3 has no pgvector ⇒ JS cosine over a 500-cap. Fine at personal scale; the named escalation is Postgres + pgvector/HNSW (or a PGlite pgvector extension investigation). Trigger = the 500-cap truncation log (reuse CORE-16's signal).
- **Chunk granularity** (whole session vs turn-window + overlap): recall vs storage/precision tradeoff — measure, don't guess.
- **v1 plateau:** without rerank (ladder #2) and HyDE (#7), v1 may sit at/near the adapter's 79% rather than high-90s. That's acceptable for v1 (it's still +60pp over the 12–18% baseline); the ladder is the path up.
- **Dogfood wiring:** the chat memory protocol currently runs against the `iranti_dev` daemon, not `iranti-next` (the local build carrying these changes). Repointing it is a separate, explicit decision (`project/iranti/mcp_wiring_daemon_vs_next_corrected`) — referenced here because it determines whether we eat our own cooking on CORE-17.

## Changelog
- 2026-07-05 — proposed (branch `feat/core-17-retrieval-first`). Awaiting NF acceptance before implementation (PRD-first rule). Open decisions: §8 re-ratification of exact-first→routed; §9 recall-embedder default.
- 2026-07-05 — **decisions locked (NF):** §8 doctrine re-ratified (vector rides *backseat to deterministic*, not off — deterministic drives, semantic takes the wheel on open/alias-gap queries); §9 recall-embedder default = ON-when-reachable, else silent OFF. Still PRD-first: implementation opens with §7 acceptance as failing bench targets. The decision register (`docs/decisions/open-decisions.md`) gets the CORE-17 row at build start.
