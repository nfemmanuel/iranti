# PRD: Phase 3 — The Attendant: retrieval, payload contract & autonomous writes

**Status:** proposed
**Phase:** 3 · **Date:** 2026-06-10 · **Author:** Claude (with NF)
**Related:** master PRD §6 (the Attendant), §8 (inner workings), §12 Phase 3, §13 open questions (the stream, drift N, pass weighting); [alignment review 2026-06-10](../../reviews/2026-06-10-alignment-and-enforcement.md) (Branch C + universal-mechanism amendment); backlog Phase 3 gate items 1–4; CORE-15/16/17/30 + new CORE-31…34; specs [two-pass](../../specs/retrieval/two-pass-retrieval.md), [periodic drift](../../specs/retrieval/periodic-drift-check.md), [graph traversal](../../specs/retrieval/graph-traversal-retrieval.md), [context-window observation](../../specs/retrieval/context-window-observation.md)

---

## 1. Summary

Phase 3 makes the rebuild *the Attendant the master PRD describes* — and closes the founding-principle inversion the alignment review documented. Four moves. **(1) Retrieval becomes two-pass:** the existing entity+keyword pass becomes the primary; a secondary pass walks the knowledge graph (1–2 hops over the edges Phases 2a/2.5 have been accumulating) for peripheral facts, returned as a distinct tier. **(2) The attend lifecycle becomes a contract:** `phase` (pre/mid/post) enters the tool schema, every response carries a protocol breadcrumb ("what is due next"), and the attend payload is formally recognized as the stream — answering master §13's open question. **(3) Writes go autonomous-first:** server-side extraction from the attend payload becomes the *primary* write path on every host (chat or code); explicit `iranti_write` becomes the high-confidence override; the backstop autowrite ships *born inverted* — it auto-writes and warns, never blocks by default. **(4) The four gate items are resolved:** AGE decision (D1), `getNeighbors` depth>1 fix (CORE-34), token-budgeted injection calibrated on 2.5's `attend_log` data (CORE-33), `metric_counters` tenancy (D4). Plus the `media_objects` schema (CORE-30) and stale-context corrections (CORE-17).

## 2. Problem & motivation

**Retrieval is one-pass and graph-blind.** Since 2a the system has recorded `co_access`, `governs`, `co_write`, and `about` edges — and nothing reads them. Master §8: retrieval is two-pass, "what the query clearly needs and what might matter at the edges." Today a fact one hop away (same decision cluster, different entity) is invisible.

**The agent is still the orchestrator.** The alignment review's core finding: the PRD says the agent is passive and iranti invisible; the running system makes the agent perform six protocol duties and hand-author every fact. The universal fix (Branch C amendment) is architectural, not hortatory: the attend payload is the stream; extraction happens server-side; responses carry breadcrumbs. The rebuild has the embryo (2b's extractor runs inside attend) but extraction is a 9-pattern heuristic and there is no payload contract, no phases, no breadcrumbs, no backstop.

**Injection is count-capped, not token-capped.** `MAX_TOTAL_FACTS = 20` can be 200 or 20,000 tokens. 2.5-D3 deliberately deferred the budget until `attend_log` existed; it exists, with real distribution data.

**Corrections never fire.** Phase 1.2 ships suppression (stale info already in window → withhold duplicates) but not correction (stale info in window → surface the current value). Master §8: "If the context window contains stale or inaccurate information, iranti surfaces the correct version as a correction." The drift heartbeat (§13 open question) was never built. The done-enough list requires the correction-to-injection ratio to be measurable.

**Known bugs gate this phase.** `getNeighbors` depth>1 walks backward (second OR branch matches the frontier's *source*) and discards weight ordering before LIMIT — confirmed twice in review. Two-pass consumes exactly this code path.

## 3. Goals & non-goals

**Goals**
- Two-pass retrieval: primary (entity+keyword, existing) + secondary (graph 1–2 hops, weight-ordered), tiers distinguishable by the host.
- Attend payload contract: `phase` pre/mid/post with distinct economics; breadcrumb field in every response; first attend of a session auto-bootstraps (registration + working brief — no separate handshake tool).
- Server-side extraction as the primary write path: expanded extractor corpus + extraction from `currentContext` deltas, not just `latestMessage`.
- Backstop autowrite (born inverted): unrecorded-signal detection server-side; auto-write at reduced confidence + warn breadcrumb; blocking only behind `IRANTI_ENFORCE=true`.
- Token-budgeted injection with priority order (rules > checkpoint > primary > secondary), default calibrated from `attend_log`.
- Periodic drift check every N turns; stale-context corrections (CORE-17) surfaced as a distinct response block; correction:injection ratio queryable.
- `getNeighbors` depth>1 correct (forward-only, weight-ordered before LIMIT).
- `media_objects` table (CORE-30), schema-only.
- `metric_counters` gains `tenant_id`.

**Non-goals**
- **CORE-18 EntityAlias + CORE-19 surface-aware retrieval** → deferred (D10): neither blocks the Attendant contract; keep the phase shippable.
- **Apache AGE switchover** → stays parallel-track (D1); this phase fixes the CTE impl instead.
- **Media ingest behavior** → CORE-30 is schema-only; ingest needs its own spec (master §13).
- **Hebbian decay, archivist** → Phase 4. Edges strengthen and are now *read*; nothing decays yet.
- **Hook configurations for specific hosts** → Claude-Code sugar documented in integrations.md, not core deliverables (Branch C amendment: hooks are tier-2).
- **OAuth, RLS, real tenancy** → Phase 5.

## 4. Scope

**In**
- **CORE-15** two-pass retrieval (primary existing + graph-hop secondary; tier metadata in attend response).
- **CORE-16** pgvector + hybrid search — **config-gated** (D6): embeddings via optional local model (Ollama, same pattern as 2b's LLM extractor); keyword+graph remains the default. Schema (vector column + index) lands regardless.
- **CORE-17** stale-context correction: when `currentContext` contains a superseded value for a known fact, attend returns a `corrections` block (extends 1.2's suppression machinery — same matching, opposite action).
- **CORE-30** `media_objects` table, typed, migration, zero behavior.
- **CORE-31** attend payload contract: `phase` param (pre/mid/post), mid-turn economics (small budget, turn-dedup, no rule rescan), breadcrumb field (`nextDue`) in every tool response, session auto-bootstrap on first attend.
- **CORE-32** extraction as primary write path: extractor corpus expansion (target: the conversational signal classes — decisions, preferences, constraints, failed approaches, corrections), `currentContext` delta extraction, extraction telemetry (facts/attend in `attend_log`).
- **CORE-33** token-budgeted injection: budget default from `attend_log` distribution (proposal: p75 of observed injection sizes, ~configurable), priority order, truncation accounted in `suppressed_tokens_est`.
- **CORE-34** graph traversal fix: forward-only join, weight ordering before LIMIT, regression tests at depth 2.
- Drift heartbeat: server-side turn counter per session; every N turns (default **N=5**, D9) run staleness comparison; counter resets on fire.
- `metric_counters` migration: PK `(tenant_id, name)`.
- Tests + smoke for all of the above.

**Out (deferred):** CORE-18/19 (later), AGE switchover (gated, D1), media ingest (own spec), REST/B5, OAuth (5), dashboards (iranti-web).

## 5. Design decisions & rationale

- **D1 — stay on the CTE graph impl; define AGE switchover triggers → why (gate 1):** nothing yet measures the CTE at production depth; switching backends before the first consumer exists optimizes blind. Triggers for revisiting (recorded, measurable): depth-2 traversal p95 > 150 ms at current edge volume, or edge count > 1M, or a Phase 4+ feature needs Cypher-only semantics. **Rejected:** starting the AGE build now (parallel maintenance cost with zero reads to justify it); deciding never (the interface abstraction from 2a exists precisely to keep this swappable).

- **D2 — secondary pass = graph hops from primary hits, not a wider keyword net → why (CORE-15):** the graph encodes *earned* relatedness (co-access, co-write, rule co-fire) that keyword matching cannot see; a wider keyword net just lowers precision. Secondary facts arrive in a separate `peripheral` array, weight-ordered, capped, each carrying its connecting relation as provenance. Answers master §13's presentation question: **separate blocks, not merged** — hosts render tiers differently and merging discards the distinction. **Rejected:** merged list with tier metadata (hosts will ignore the flag and treat periphery as primary); score-threshold single pass (no principled threshold exists across heterogeneous scoring).

- **D3 — `phase` enters the attend schema; mid is first-class → why (CORE-31):** pre/mid/post have distinct triggers *and* distinct economics (alignment review §5): pre = full budget at turn start; mid = discovery-triggered top-up (small budget, dedup against the turn, no rule rescan); post = persist + close (extraction runs against the full turn payload, checkpoint update, counters). Folding mid into pre forfeits the cheap-top-up semantics that make mid affordable. Auto-bootstrap on first attend replaces a separate handshake tool — one less protocol step for every host. **Rejected:** separate handshake tool (another thing hosts must remember — contradicts one-habit); phase-less attend (v0's lesson: lifecycle state enables compliance, dedup, and economics).

- **D4 — `metric_counters` becomes `(tenant_id, name)` → why (gate 4):** review finding; every sibling table carries the seam; cheapest now while rows ≈ 4. **Rejected:** global counters forever (Phase 5 would aggregate tenants invisibly).

- **D5 — breadcrumbs: every tool response carries `nextDue` → why (CORE-31, Branch C):** the universal carrier on every host is the tool result itself. A one-line field ("post-response attend due", "3 unrecorded observations — will auto-write on next attend") moves lifecycle tracking from the agent's memory to the channel. **Rejected:** host-specific reminders (hooks/system prompts — tier-2 only); silence (the current rebuild state: the agent must simply know).

- **D6 — embeddings config-gated, keyword+graph default → why (CORE-16):** model-agnosticism (§2) and the zero-dependency posture argue against a hosted embedding API in core; a local model (Ollama) matches 2b-D1's pattern. The schema lands now so enabling is a config flip, not a migration. **Rejected:** hosted embeddings by default (dependency + key + cost + privacy posture); skipping the schema (re-migration later for no savings).

- **D7 — extraction is the primary write path; explicit write is the override → why (CORE-32, Branch C amendment):** on chat hosts payload-extraction is the *only* possible autonomous mechanism, so it must carry the load; agent-authored writes remain for high-confidence, well-structured facts (and keep their D7-2.5 confidence advantage via source reliability). Extraction quality becomes the phase's central risk and gets its own test corpus + telemetry. **Rejected:** hook-first design (Claude-Code-only — the exact mistake the amendment corrects); LLM-extraction by default (2b-D1 stands: deterministic heuristics default, local LLM optional).

- **D8 — backstop autowrite born inverted → why (CORE-32):** v0's write guard proved detection works and blocking hurts (the friction is documented across two sessions). The rebuild never ships the blocking form: unrecorded-signal state accumulates server-side; next attend triggers auto-extraction of the pending material; the breadcrumb reports what was written; `IRANTI_ENFORCE=true` opts into hard blocking for integration debugging. **Rejected:** porting v0's guard as-is (recreates the documented inversion); no backstop (silent memory loss on hosts with lazy agents).

- **D9 — drift N defaults to 5 → why:** master §13 demands a defended default. At N=1 the heartbeat is a per-turn tax duplicating pre-response work; beyond ~8 turns drift compounds past cheap correction (a session summary's worth of staleness). 5 turns ≈ the cadence at which 1.2's suppression data shows `currentContext` meaningfully diverging. Configurable (`IRANTI_DRIFT_N`); `attend_log` gains `corrections_count` so the ratio is one query. **Rejected:** adaptive N (tune after real data, not before); per-host N (config surface with no evidence yet).

- **D10 — CORE-18/19 out → why:** EntityAlias and surface-aware retrieval are additive lookups touching nothing in the contract; this phase is already the largest since Phase 0. **Rejected:** folding them in (scope risk to the inversion-closing work, which is the strategic payload).

## 6. Schema / API changes

- **`facts`**: optional `embedding vector(768)` column + HNSW index (created only when embeddings enabled).
- **New table `media_objects`** (CORE-30): `id`, `tenant_id`, `entity_type`, `entity_id`, `key`, `object_url`, `mime_type`, `description_text`, `metadata`, `created_at`. No read/write path.
- **`metric_counters`**: PK → `(tenant_id, name)`; rows migrate to `'default'`.
- **`attend_log`**: + `corrections_count`, `facts_extracted`, `phase`.
- **`sessions`**: + `turn_count` (drift heartbeat state).
- **attend input**: + `phase` ('pre-response' | 'mid-turn' | 'post-response', optional, default pre), `latestMessage` alias honored.
- **attend output**: + `peripheral[]` (tier 2 with relation provenance), `corrections[]`, `nextDue` breadcrumb; all tool responses gain `nextDue`.
- **`getNeighbors`**: behavior fix only, interface unchanged.

## 7. Acceptance criteria

- [ ] An attend for entity A returns a fact of entity B in `peripheral[]` when linked by an `about`/`co_access` path within 2 hops — with zero keyword overlap.
- [ ] Depth-2 traversal returns only forward-reachable nodes, ordered by weight before the limit (regression test on the review's counterexample).
- [ ] A decision stated in plain conversation (no tool-aware phrasing) is stored as a fact with **no explicit write call**, and surfaces on the next attend — the conversational-host test.
- [ ] A session with extractable signal and zero explicit writes still accumulates facts (backstop); nothing blocks at default enforcement; `IRANTI_ENFORCE=true` blocks.
- [ ] Injection never exceeds the token budget; rules and checkpoint survive truncation first; trimmed amounts appear in `suppressed_tokens_est`.
- [ ] When `currentContext` contains a superseded value, `corrections[]` carries the current value (not a duplicate injection); correction:injection ratio is one SQL query.
- [ ] Drift check fires every N turns (counter visible in `sessions.turn_count`), resets on fire.
- [ ] `phase=mid-turn` dedups facts already injected this turn and skips the rule rescan; `phase=post-response` runs extraction over the turn payload.
- [ ] Every tool response carries `nextDue`; first attend of a fresh session auto-bootstraps agent + session.
- [ ] `media_objects` exists and is typed; `metric_counters` is tenant-scoped; embeddings off by default, hybrid search works when enabled.
- [ ] Full suite + smoke green; new smoke: graph-hop retrieval, conversational extraction, correction firing, budget enforcement.

## 8. Deltas from the master PRD

Implements §12 Phase 3 (both Attendant halves) with two deliberate departures. **(1) The stream is the attend payload**, not a host-pushed event stream — answering §13's open question in the form every MCP host can actually deliver; hooks/streaming remain richer tiers per the alignment review's capability ladder. **(2) No separate handshake tool** — auto-bootstrap on first attend; §12's handshake duties (rules load, brief assembly, registration) happen there. Master §2's "invisible / negligible / agnostic" principles are reconciled via the ladder: behavior is host-agnostic, invocation mechanism is tiered. CORE-30 lands here per the 2026-06-10 decision so Phase 3 retrieval can consume media descriptions from day one (consumption itself: media spec, later).

## 9. Risks & open questions

- **Extraction quality is the load-bearing risk.** Too eager → noise floods the store and peripheral tier amplifies it; too timid → autonomous writing fails its promise and the inversion quietly returns. Mitigations: test corpus before tuning, extraction telemetry in `attend_log`, reduced confidence on autowrites (reliability scoring then arbitrates), Phase 4 decay as the long-term cleaner.
- **Graph noise becomes visible.** Two years of edge accumulation has never been *read*; first consumption may surface junk paths. Weight floor + cap on peripheral tier; D9-2.5's low co_write weight helps; watch via health views.
- **Budget starvation.** A too-low default starves the secondary tier to zero. Priority order protects rules/checkpoint; budget is per-call configurable.
- **Scope.** Largest phase since the rebuild began. Build order if splitting becomes necessary: CORE-34 → 31 → 32 → 15 → 33 → 17/drift → 30/16 (each independently shippable).
- **Q1:** embedding model default when enabled (nomic-embed-text vs bge) — decide at build, behind config either way.
- **Q2:** should `peripheral[]` facts update `lastAccessedAt`? Lean **no** — surfacing periphery isn't evidence of use; let explicit access strengthen (cleaner Phase 4 signal).
- **Q3:** breadcrumb verbosity — single `nextDue` string vs structured object. Lean string (hosts shouldn't parse protocol state).

## 10. Verification

- Unit/integration: traversal direction + ordering, tier separation, extraction corpus (precision/recall per signal class), backstop trigger + enforce mode, budget truncation order, correction matching vs suppression matching, drift counter, phase economics (mid dedup, post extraction), bootstrap idempotency, tenancy migration.
- Smoke: conversational write→attend round-trip with zero explicit writes; graph-hop surfacing; correction on planted stale context; budget cap visible in attend_log.
- `pnpm build` clean; full vitest green; smoke green.

## Changelog
- 2026-06-10 — proposed (scope: CORE-15/16/17/30 + new 31–34; gate items 1–4 resolved as D1/CORE-34/CORE-33/D4; Branch C + amendment baked in as CORE-31/32; CORE-18/19 deferred by D10)
- _pending_ — accepted
- _pending_ — shipped
