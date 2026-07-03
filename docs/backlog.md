# iranti-core backlog

**The single ordered queue for iranti-core.** What is shipped, what is in flight, what is next, what is parked — with a stable ID per item.

**[Back to map](MAP.md)** · **[Phase PRDs](prds/phases/)** · **[Implementation reference](engineering/implementation.md)** · **[Master PRD](rough-notes/iranti-core-prd.md)**

---

## How the planning docs fit together

| Document | Role | Tense | Changes |
|---|---|---|---|
| **Master PRD** | The vision — what iranti is and why. | Timeless | Rarely |
| **Phase PRDs** | The contract for one phase, written **before** build. | Future → past | Once per phase |
| **This backlog** | The ordered queue. Where everything stands right now. | Present | Continuously |
| **Implementation reference** | The living retrospective — what was actually built and why. | Past | After each build |

Workflow: an item moves **backlog (later) → PRD proposed → PRD accepted → in progress → shipped**, and on ship it earns a closing entry in `implementation.md`. No item enters "in progress" without an accepted PRD.

**Status legend:** 🟢 shipped · 🟡 in progress · 🔵 PRD accepted, not started · ⚪ later (no PRD yet) · 🔴 blocked

---

## Phase numbering — reconciled

The master PRD §12 and the executed build use **different** phase numbers. This was flagged in the June 2026 audit (`goals_audit_2026_06`, divergence 4). The **executed scheme below is canonical** going forward; the master PRD §12 remains the original plan of record and should carry a pointer to this table.

| Executed phase (canonical) | Maps to master PRD §12 | Why it differs |
|---|---|---|
| **0 — Library Foundation** | 0 Foundation **+** 1 The Library | Foundation and library CRUD were folded into one phase. |
| **1 — MCP Server** | 5 MCP integration | **Pulled forward** to get a runnable end-to-end loop early (de-risks every later phase). |
| **1.1 — Tool Realignment** | (interstitial) | Hardening: 4→9 tools, recency→keyword retrieval. No master-PRD equivalent. |
| **1.2 — Context Window Observation** | part of 3 (The Attendant) | First slice of §8 window observation, pulled next to attend. |
| **2 — Librarian, graph & write safety** | 2 The Librarian + graph | Aligned. Now also carries co-access edges + write serialization + semantic extraction. |
| **2.5 — Single-user HTTP + telemetry** | part of 5 | Unlocks consumer surfaces; carries the metrics `attend_log`. |
| **3 — Retrieval & cross-platform** | 3 The Attendant (retrieval half) | Two-pass, graph-traversal, vector, full window correction, entity aliases. |
| **4 — Memory Lifecycle** | 4 The Archivist | Aligned. Decay + **edge** Hebbian reinforcement. |
| **5 — Multi-user SaaS** | (beyond §12; §10 security) | Auth, tenancy, RLS, OAuth. |
| **6 — CLI & SDK** | 6 CLI and SDK | Aligned. |
| **7 — Observability** | 7 Observability | Aligned. |

> Note: the master PRD's **Attendant** (§6) is one component whose behaviours are spread across executed phases 1 (bidirectional seed), 1.1/1.2 (relevance + window), 2 (write routing), and 3 (two-pass, stream). The **Librarian** and **Archivist** map cleanly to executed phases 2 and 4.

---

## Shipped (done log)

| ID | Item | Phase | PRD | Evidence |
|---|---|---|---|---|
| 🟢 CORE-0 | Library foundation — 6 tables, CRUD, archive, migrations, CI | 0 | [phase-0](prds/phases/phase-0-foundation.md) | `7fadef5` (+`3321c8c`), 46 tests |
| 🟢 CORE-1 | MCP server — bidirectional attend, 4 tools, checkpoints, stdio | 1 | [phase-1](prds/phases/phase-1-mcp-server.md) | `b506a38`, 89/89 + 9/9 smoke |
| 🟢 CORE-2 | Tool realignment — 4→9 tools, keyword relevance scoring | 1.1 | [phase-1.1](prds/phases/phase-1.1-tool-realignment.md) | 104/104 + 16/16 smoke |
| 🟢 CORE-3 | Context window observation — `currentContext` + already-present suppression | 1.2 | [phase-1.2](prds/phases/phase-1.2-context-window-observation.md) | 109/109 + 17/17 smoke |
| 🟢 DOC-1 | PRD-first process + retroactive PRDs for 0/1/1.1 + this backlog | — | [phases/README](prds/phases/README.md) | this commit |
| 🟢 CORE-4 | Phase 2 PRDs written & accepted (split into 2a/2b) | 2 | done | [2a](prds/phases/phase-2a-graph-and-write-safety.md) · [2b](prds/phases/phase-2b-librarian.md) |
| 🟢 CORE-5 | Write serialization — `pg_advisory_xact_lock` in `writeFact` | 2a | done | [2a](prds/phases/phase-2a-graph-and-write-safety.md) |
| 🟢 CORE-6 | `knowledge_edges` table + `GraphBackend` interface + PostgreSQL CTE impl | 2a | done | [2a](prds/phases/phase-2a-graph-and-write-safety.md) |
| 🟢 CORE-7 | Co-access edge recording in attend (async, fire-and-forget) | 2a | done | [2a](prds/phases/phase-2a-graph-and-write-safety.md) |
| 🟢 CORE-8 | `governs` edges from rules to co-fired facts | 2a | done | [2a](prds/phases/phase-2a-graph-and-write-safety.md) |
| 🟢 CORE-9 | Conflict detection — minimal (same-key reliability gap → supersede/escalate) + deep cross-key (comprehension metric) | 2b | done | [2b](prds/phases/phase-2b-librarian.md) |
| 🟢 CORE-10 | Source reliability scoring — `source_reliability(source, wins, losses, score)` table, updated on every supersession | 2b | done | [2b](prds/phases/phase-2b-librarian.md) |
| 🟢 CORE-11 | Server-side semantic extraction — `HeuristicExtractor` (always-on) + `LocalLlmExtractor` (Ollama, optional), wired into attend | 2b | done | [2b](prds/phases/phase-2b-librarian.md) |
| 🟢 CORE-12…14, 27…29 | Phase 2.5 — HTTP transport, `attend_log` + health views, confidence plumbing, `source_reliability` tenancy, write-time edges | 2.5 | `086c4941` (+`2e3cccb7`) | [2.5](prds/phases/phase-2.5-http-telemetry.md) |
| 🟢 CORE-15…17, 30…34 | Phase 3 — two-pass retrieval, graph-hop, payload contract, extraction-primary writes, token budget, stale-context correction, `media_objects` schema, pgvector scaffolding (embedding + HNSW; hybrid-search retrieval path deferred) | 3 | `a26febe7`→`74f5a89a` (+`f01f8e80`) | [3](prds/phases/phase-3-attendant-retrieval.md) |
| 🟢 AX-1 | Key normalisation — `normalizeKey` at all fact write/read boundaries; migration 0011 | AX | `13190c60` (+`7b6c2089`) | [ax-1](prds/phases/ax-1-key-normalization.md) |
| 🟢 AX-2 + OD-4 | Content-hash extraction cache (AX-2) + media ingest pipeline (OD-4) | AX / OD | `16ee3916` (+`991ce3bf`, `35e4e0a6`, `c59e608c`) | [ax-2](prds/phases/ax-2-content-hash-cache.md) · [od4](prds/phases/od4-media-ingest.md) |

---

## Now / Next (live queue)

| ID | Item | Phase | Status | PRD |
|---|---|---|---|---|
| 🟢 CORE-12…14, 27…29 | **Phase 2.5** — single-user HTTP, `attend_log` telemetry + token accounting, Phase 2 hardening (confidence plumbing, reliability tenancy, write-time edges) | 2.5 | shipped | [2.5](prds/phases/phase-2.5-http-telemetry.md) |
| 🟢 CORE-15…17, 30…34 | **Phase 3** — the Attendant: two-pass retrieval + graph-hop, payload contract (pre/mid/post + breadcrumbs), extraction-primary writes + born-inverted backstop, token budget, corrections, gate items 1–4 | 3 | shipped | [3](prds/phases/phase-3-attendant-retrieval.md) |
| 🟢 AX-1 | **AX-1 — Key Normalisation** — `normalizeKey` at all fact write/read boundaries; migration 0012 | AX | shipped | [ax-1](prds/phases/ax-1-key-normalization.md) |
| 🟢 AX-2 + OD-4 | **AX-2 + OD-4** — content-hash extraction cache + media ingest pipeline | AX / OD | shipped | [ax-2](prds/phases/ax-2-content-hash-cache.md) · [od4](prds/phases/od4-media-ingest.md) |
| ⚪ DOC-2 | Flip spec `template` → `complete` as features ship; add master-PRD §12 pointer to the reconciliation table | — | later | n/a |

> **Current frontier:** Phase 4 (Memory Lifecycle) + AX/OD tracks. Phase 3 and all AX-1/AX-2/OD-4 items are shipped.

---

## Phase backlog (later)

### Phase 2a — Graph Foundation & Write Safety  🟢 shipped

Graph substrate + concurrency safety. PRD: [phase-2a](prds/phases/phase-2a-graph-and-write-safety.md). 125/125 tests · 19/19 smoke.

- **🟢 CORE-5** Write serialization via `pg_advisory_xact_lock` — closed the Phase 1 single-instance race.
- **🟢 CORE-6** `knowledge_edges` table + `GraphBackend` interface + PostgreSQL recursive-CTE impl.
- **🟢 CORE-7** Co-access edge recording in attend — fire-and-forget, off the response path.
- **🟢 CORE-8** `governs` edges from rules to the facts they co-fire with.

### Phase 2b — The Librarian  🟢 shipped

Judgment on the write path. PRD: [phase-2b](prds/phases/phase-2b-librarian.md). 158/158 tests · 21/21 smoke.

- **🟢 CORE-9** Conflict detection — minimal (same-key + confidence/source gap → supersede or escalate-file) **and** deep cross-key semantic detection wired as a **comprehension metric** (flags + measures, never auto-resolves).
- **🟢 CORE-10** Source reliability scoring — `source_reliability(source, wins, losses, score)`, updated on every supersession outcome.
- **🟢 CORE-11** **Server-side semantic extraction** — `HeuristicExtractor` (always-on, 5 decision patterns + 4 preference patterns) + `LocalLlmExtractor` (Ollama, config-gated, degrades to heuristic), pluggable `ExtractorBackend`. Wired into `attend` fire-and-forget. Facts surface on next attend.

### Phase 2.5 — Single-user HTTP, telemetry & Phase 2 hardening  🟢 shipped

One engineering effort that unlocks every consumer surface + makes the token-saving story measurable. PRD: [phase-2.5](prds/phases/phase-2.5-http-telemetry.md). Write-safety precondition (CORE-5) satisfied by 2a.

- **CORE-12** Streamable HTTP transport alongside stdio, static bearer token, off by default (building block B3 from [integrations.md](engineering/integrations.md)).
- **CORE-13** `search`/`fetch` alias tools for the ChatGPT connector shim (B4), gated by `IRANTI_EXPOSE_OPENAI_ALIASES`.
- **CORE-14** `attend_log` table (counts, injected/suppressed sizes in chars + token estimate, latency) + `metric_counters` persistence + the SQL health views. Foundation of "tokens saved this week". *Token-budgeted injection is deferred to Phase 3 by decision D3 — 2.5 measures, 3 enforces.*
- **CORE-27** Confidence plumbing — `writeFact` accepts confidence; extractor confidence (0.85/0.80) stops being dropped; reliability-weighted via `clamp(base × (0.5 + sourceScore))`. *(Strategic-review gap 1; master §12 "apply weighted confidence on write".)*
- **CORE-28** `source_reliability.tenant_id` + composite PK — the one missing tenancy seam. *(Gap 2.)*
- **CORE-29** Write-time edges — `co_write` same-session (weight 0.5) + `about` fact→entity, fire-and-forget. *(Gap 3; master §12 "temporal co-occurrence, entity overlap".)*

> **✅ GATE CLEARED (2.5):** "tokens saved this week" — answerable via `SELECT * FROM iranti_health_suppression` (`scripts/health.sql`, view `iranti_health_suppression`). Attend latency measured in `iranti_health_latency`. Comprehension counters wired via `metric_counters` persistence. All three gate conditions satisfied. Phase 2.5 shipped `086c4941`.

### Phase 3 — Retrieval & cross-platform  🟢 shipped

The retrieval half of the Attendant. PRD: [phase-3](prds/phases/phase-3-attendant-retrieval.md). Ship commit `a26febe7`→`74f5a89a` (+`f01f8e80`).

> **✅ GATE CLEARED — Phase 3 shipped.** All four gate items resolved before/during Phase 3 build:
> 1. **Apache AGE decision** — resolved as D1 in Phase 3 PRD: CTE impl carries the load; AGE deferred until query complexity demands it.
> 2. **`getNeighbors` depth>1 fix** — resolved as CORE-34 (`a26febe7`): recursive-CTE OR branch corrected; weight ordering preserved before LIMIT.
> 3. **Token-budgeted injection** — resolved as CORE-33 (`a76de0ea`): priority-ordered budget enforcement using `attend_log` distribution data.
> 4. **`metric_counters` tenancy** — resolved as D4 / CORE-31 (`3076515e`): `tenant_id` column added; `persistMetricCounters` writes per-tenant rows.

- **CORE-30** `media_objects` schema — `(id, tenant_id, entity_type, entity_id, key, object_url, mime_type, description_text, metadata, created_at)`. Schema-only; no ingest behavior. Needs its own spec (master PRD §252/§551 requires one). Lands here so retrieval (CORE-15/16) can consume it from day one. *(Decision 2026-06-10: deferred from Phase 2.5 — 2.5 already dense; media schema with no consumer would sit inert for two phases.)*
- **CORE-15** **Two-pass retrieval** — primary = entity + keyword match; secondary = 1–2 hop graph neighbours weighted by edge confidence. *Falls out of CORE-7 nearly for free; answers the master PRD's open question on tier weighting.*
- **CORE-16** pgvector embeddings + hybrid search (lexical + cosine) — the third rung of the relevance ladder (entity → keyword → vector).
- **CORE-17** **Full context-window correction** — detect *stale* values in the window and surface the correction, not just suppress (completes §8; Phase 1.2 only suppressed).
- **CORE-18** `EntityAlias` — one entity, many names across platforms (user/nf = user/NF).
- **CORE-19** Surface-aware retrieval — optionally scope reads to specific hosts.

### Phase 4 — Memory Lifecycle  ⚪

- **CORE-20** Ebbinghaus decay — `confidence × e^(-(days_since_access / stability))`; archivist daemon archives below threshold; checkpoints exempt.
- **CORE-21** **Hebbian reinforcement on graph edges** (co-retrieval strengthens edges). *Note: this is EDGE strengthening per master PRD §7 — not the fact-level `stabilityScore` bump that `implementation.md` currently describes. Reconcile that wording when this lands.*
- **CORE-22** `iranti resolve` CLI for human conflict review; archivist applies resolved escalations.

### Phase 5 — Multi-user SaaS  ⚪

- **CORE-23** `users` + `tokens` tables; row-level security on fact queries (the `tenantId` seam goes live).
- **CORE-24** Cross-platform identity resolution (user merge); consumer OAuth; usage metering.

### Phases 6–7 — CLI/SDK & Observability  ⚪

- **CORE-25** CLI (bind project, query memory, diagnostics, run archivist), TypeScript SDK, Python client.
- **CORE-26** Session ledger, operational metrics, opt-out telemetry, agent registry, protocol enforcement.

---

## Cross-cutting / debt

- **DEBT-1** Multi-entity-hint + message retrieval orders facts by hint order, not cross-entity relevance (deferred from 1.1 → Phase 3 / CORE-16).
- **DEBT-2** attend access-tracks facts it later suppresses as already-present (Phase 1.2). Defensible as "relevant this turn"; revisit only if Phase 4 decay calibration shows it matters.
- **DEBT-3** Spec docs under `docs/specs/**` are still `template` while their features ship (checkpoints, rules, fact storage). Flip statuses as phases close (DOC-2).
- **DEBT-4** `implementation.md` Hebbian wording redefines edge-reinforcement as fact `stabilityScore`; reconcile at CORE-21.
- **DEFER-1** **Manual-edit / change-graph.** Account for users editing files outside an agent session — a GitHub/Bitbucket-style change graph so the agent's memory of the codebase doesn't go stale. This is the master PRD §13 "manual edit problem" risk (git integration / file watchers). Parked by explicit decision (2026-06-10); revisit after the core loop is proven.
- **DEFER-2** **Write-guard → protocol enforcement.** Retire the blocking-per-edit write guard; reintroduce at Phase 7 as *configurable, advisory-by-default* protocol enforcement keyed on findings/turns, not raw edit-events. (Lives in the v0 server, not iranti-core — see `write_guard_recommendation`.)
- **RULE-1** **Tokenizer short-token floor.** `tokenizeMessage`'s length>=3 filter drops 2-char tokens (S3, PR, UI, CI) from both messages and rule text, so short-codename rules can never match on their defining token (Layer 0d review finding). Fix = measured change: lower/special-case the floor and re-run the full bench, since the tokenizer is shared with fact relevance scoring.
- **RULE-2** ✅ **FIXED (2026-07-03)** — Teardown vs fire-and-forget chains (production hang risk). Root-fixed by `src/library/background.ts`: all six detached fire sites (attend chain, writeFact's three post-commit side effects, extraction-cache hit-bump + write) register via `trackBackground`; `closeDb()`/the PGlite `pool.end` shim settle the registry (bounded 5s, engine-aware single settle, timeout logged) before teardown. Sleepless regression: `src/tests/teardown-race.test.ts` (verified to genuinely hang pre-fix). The 300ms sleeps in older test files remain as harmless cushions, no longer load-bearing.

---

## Divergence tracker (from `goals_audit_2026_06`)

| # | Divergence | Status |
|---|---|---|
| 1 | attend lacked relevance + window observation (regression vs v0) | 🟢 **resolved** — keyword scoring (1.1, CORE-2) + window suppression (1.2, CORE-3); full correction → CORE-17 |
| 2 | Graph is the relevance engine; co-access edges must start in Phase 2 | 🟢 **resolved** — CORE-7 (Phase 2a, co-access edges from day one) + CORE-15 (Phase 3, two-pass graph-hop retrieval) both shipped |
| 3 | 9 agent-driven tools vs agent-passive vision | 🟢 **resolved** — [2b](prds/phases/phase-2b-librarian.md) CORE-11 shipped: server-side extraction; tools are now escape hatches |
| 4 | Conflicting phase numbering; 31 specs still template | 🟢 **resolved** (numbering, this doc) + ⚪ DOC-2 (spec status hygiene ongoing) |

---

_Last updated: 2026-06-28 (Phase 3 shipped — CORE-15/17/30/31/33/34 complete. CORE-32: non-blocking auto-write shipped; `IRANTI_ENFORCE` blocking branch deferred. CORE-16: pgvector scaffolding only — `facts.embedding vector(768)` + HNSW index pre-placed (off by default), hybrid-search retrieval path deferred; pgvector/pgvector:pg17 Docker image. AX-1 key normalisation shipped 13190c60 (migration 0011). AX-2 content-hash cache + OD-4 media ingest shipped 16ee3916 (+991ce3bf/35e4e0a6/c59e608c). Phase 2.5 health views completed scripts/health.sql.)_
