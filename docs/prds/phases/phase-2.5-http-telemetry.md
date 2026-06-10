# PRD: Phase 2.5 — Single-user HTTP, telemetry & Phase 2 hardening

**Status:** proposed
**Phase:** 2.5 · **Date:** 2026-06-10 · **Author:** Claude (with NF)
**Related:** master PRD §3 (goals: negligible overhead, token-cost reduction, self-awareness), §11 (metrics and observability), §12 Phase 5 (MCP/hosts) and Phase 2 (write-path leftovers); [integrations.md](../../engineering/integrations.md) building blocks B3/B4; backlog CORE-12/13/14 + CORE-27/28/29; `phase_2_strategic_review` (2026-06-10); [rag-and-context-engineering](../../research/rag-and-context-engineering.md)

---

## 1. Summary

Phase 2.5 does three things. **(1) It takes iranti remote**: the same MCP server, served over Streamable HTTP with a static bearer token, which unlocks every consumer surface researched (claude.ai, Claude mobile, ChatGPT, Le Chat, Grok, Perplexity web, M365 Copilot) — none needs more than this plus per-host auth polish. **(2) It makes iranti measurable**: an `attend_log` table records the size, suppression count, and latency of every injection, turning the token-saving story ("iranti saved you N tokens this week") from a claim into a number, and persisting the comprehension counters that today die on process restart. **(3) It closes the three hardening gaps the Phase 2 strategic review confirmed in code**: extractor confidence is currently computed and dropped (`writeFact` hardcodes 1.0), `source_reliability` is the only table missing the tenancy seam, and the master PRD's write-time edges (temporal co-occurrence, entity overlap) were never built.

## 2. Problem & motivation

**Every consumer surface is blocked on HTTP (B3).** Phase 1 stdio covers 8 of 15 surfaces — all developer tools. claude.ai, mobile, ChatGPT and the rest require a public Streamable HTTP endpoint. The precondition the integrations plan set — "must land after Phase 2 write serialization, a remote endpoint invites phone+laptop concurrency" — was satisfied by 2a's advisory locks.

**The token-saving goal is unmeasured.** Master §3: *"Iranti reduces the total token cost… by injecting only the context that is needed"* with *"negligible overhead."* The machinery exists (caps, relevance ranking, `currentContext` suppression) but the evidence is discarded: `alreadyPresent` is computed per-attend and thrown away; nothing measures injection size or attend latency. The §11 dashboard ("tokens saved this week") and the §3 self-awareness goal both depend on persistence that doesn't exist. This is gap 5 of the strategic review, resolved here.

**Three Phase 2 gaps are cheapest to fix now (strategic review 2026-06-10, all verified in code):**
- **Confidence plumbing (gap 1).** `writeFact` hardcodes `confidence: 1.0` ([facts.ts:195](../../../src/library/facts.ts)). `ExtractedFact.confidence` (0.85 heuristic / 0.80 LLM) goes nowhere, and the `source-reliability.ts` header's claim that scores are "applied as a confidence weight on writes" is not implemented — scores only gate supersede/escalate. Master §12 says "apply weighted confidence on write"; Phase 4 plans to seed decay stability from it.
- **`source_reliability` tenancy seam (gap 2).** Every other table carries `tenant_id`; this one doesn't. In Phase 5, reliability scores — which are shaped by user data — would silently bleed across tenants. One cheap migration now versus a data-backfill problem later.
- **Write-time edges (gap 3).** Master §12 Phase 2: "Automatic edge creation when facts are written: temporal co-occurrence, entity overlap." Phase 2 records edges only on *read* (co-access in attend). The write-side signal is uncaptured training data — the same argument that justified recording co-access from day one.

## 3. Goals & non-goals

**Goals**
- The MCP server reachable over Streamable HTTP with bearer-token auth, stdio unchanged.
- `search`/`fetch` alias tools conforming to OpenAI's deep-research connector schema, env-gated.
- An `attend_log` row per attend call: counts, sizes (chars + token estimate), suppression, latency. Fire-and-forget, content-free.
- Comprehension counters persisted across restarts.
- SQL health views over `attend_log` + existing tables for the §11 operational metrics.
- Extractor confidence flows into stored facts, weighted by source reliability, deterministically.
- `source_reliability` gains `tenant_id`.
- Write-time edges: temporal co-occurrence (same-session) and fact→entity edges, fire-and-forget.

**Non-goals**
- **REST/OpenAPI surface (B5)** → with the ChatGPT Custom-GPT write lane, later. The HTTP server is structured so `/api` can be added without rework.
- **OAuth / Dynamic Client Registration** → Phase 5. claude.ai now accepts custom credentials for non-DCR servers (verification delta #4), so a static token is enough to ship every Tier-3 surface.
- **Multi-user auth, RLS, real tenancy** → Phase 5. 2.5 only adds the seam column.
- **Token-budgeted injection** → Phase 3 (see D3). 2.5 measures; it does not change injection behavior.
- **Dashboards/UI** → iranti-web. 2.5 ships SQL views, not screens.
- **Drift checks, two-pass retrieval, embeddings** → Phase 3.

## 4. Scope

**In**
- HTTP transport (`src/mcp/http.ts` or equivalent): Streamable HTTP endpoint at `/mcp`, static bearer token from `IRANTI_HTTP_TOKEN`, port from `IRANTI_HTTP_PORT`. Off by default; stdio remains the default mode.
- `search` + `fetch` alias tools registered only when `IRANTI_EXPOSE_OPENAI_ALIASES=true`.
- `attend_log` table + write hook in attend (fire-and-forget). `metric_counters` table for comprehension metrics.
- SQL health views (attends/day, avg injection size, suppression rate, avg latency, escalation rate, source-reliability distribution).
- `writeFact` accepts optional `confidence`; extraction passes it; reliability weighting applied (D7).
- Migration: `tenant_id` on `source_reliability`, composite PK.
- Write-time edge recording in `writeFact` (fire-and-forget): `co_write` same-session edges + `about` fact→entity edges.
- Tests + smoke additions for all of the above.

**Out (deferred)**
- B5 REST (later), OAuth (5), token budget enforcement (3), dashboards (iranti-web), AGE (gated decision at Phase 3 — see backlog).

## 5. Design decisions & rationale

- **D1 — `attend_log` is one row per attend, counts and sizes only, fire-and-forget → why:** §11's hard constraint — *no metric ever includes the content of a fact, conversation, or session*. The row stores `fact_count`, `rule_count`, `already_present`, `injected_chars`, `injected_tokens_est`, `suppressed_tokens_est`, `latency_ms`, ids and timestamps — behavioral metadata only. Written after the response is assembled so attend latency is untouched (same pattern as edge recording, 2a-D3/D6). **Rejected:** logging injected fact ids (links log rows to content — unnecessary for the savings math, and a privacy surface); synchronous logging (latency on every turn).

- **D2 — token estimation is `chars / 4`, no tokenizer dependency → why:** iranti is model-agnostic (§2); "exact" token counts differ per host model anyway, so precision is illusory. A consistent estimator is correct for trends, budgets, and savings deltas, costs zero dependencies, and can be swapped behind one function if a real tokenizer is ever justified. **Rejected:** tiktoken/model tokenizers (dependency weight, false precision, picks a side on model-agnosticism).

- **D3 — measure in 2.5, budget in Phase 3 → why:** the strategic review's insight stands — `MAX_TOTAL_FACTS = 20` is a *count* cap, and 20 facts can be 200 or 20,000 tokens. But choosing a token ceiling before `attend_log` exists means tuning blind. 2.5 ships the measurement; Phase 3 (which already rebuilds retrieval as two-pass) introduces token-budgeted injection calibrated on real distribution data. **Rejected:** shipping a guess-number budget now (would change injection behavior with no data and complicate 2.5 verification).

- **D4 — comprehension counters persist via a `metric_counters` upsert table → why:** §3 requires iranti to "maintain complete awareness of its own state"; in-process counters that vanish on restart fail that. A two-column upsert (`name`, `value`, `updated_at`) incremented fire-and-forget is the leanest durable form, and the health views read it directly. **Rejected:** a metrics time-series table (overkill until iranti-web needs charts); keeping counters in-process (the current, failing, state).

- **D5 — HTTP = same `McpServer` over Streamable HTTP, static bearer token, off by default → why (B3):** the SDK serves stdio and HTTP from one tool registry, so there is no second server to maintain. A single static token from env is the minimum credential every Tier-3 host accepts today (claude.ai no longer requires DCR). Off by default keeps the local-first install identical to Phase 1. **Rejected:** OAuth now (Phase 5 scope, not required by any target surface); a separate HTTP server process (drift risk between two tool registries).

- **D6 — `search`/`fetch` aliases behind `IRANTI_EXPOSE_OPENAI_ALIASES` → why (B4):** OpenAI's deep-research connector requires exactly these two tool names; every other host would see them as confusing duplicates of `iranti_search`/`iranti_query`. Env-gating gives ChatGPT compatibility without polluting the default surface. **Rejected:** always-on aliases (duplicate-tool noise on 14 other hosts).

- **D7 — stored confidence = `clamp(base × (0.5 + sourceScore), 0, 1)` → why (CORE-27):** `base` is the writer-provided confidence (extractor 0.85/0.80; default 1.0 for explicit writes). A neutral source (score 0.5) multiplies by exactly 1.0 — no behavior change for unchallenged sources. A fully trusted source (1.0) boosts ×1.5 (clamped); a fully distrusted source (0.0) halves. Deterministic, auditable from the `source_reliability` table alone, and gives Phase 4 a real signal to seed stability from. Implements master §12 "apply weighted confidence on write" and makes the `source-reliability.ts` header truthful. **Rejected:** confidence = sourceScore directly (discards extractor signal); leaving confidence at 1.0 (the current, falsely-documented state).

- **D8 — `source_reliability` gets `tenant_id`, composite PK `(tenant_id, source)` → why (CORE-28):** matches the seam every other table has carried since Phase 0. Existing rows migrate to `'default'`. All call sites already default tenant to `'default'`, so this is schema-only today and correct on the day Phase 5 flips tenancy on. **Rejected:** global scores across tenants (a tenant's conflict history would shape another tenant's resolution behavior — a silent data-leakage class).

- **D9 — write-time edges are `co_write` (same-session, previous fact) + `about` (fact→entity), low weight, fire-and-forget → why (CORE-29):** implements master §12's "temporal co-occurrence, entity overlap" in its cheapest faithful form. `co_write` links each written fact to the previous fact written in the same session (canonicalized, weight 0.5 — half a co-access, because writing together is weaker evidence of relatedness than being retrieved together). `about` gives the graph entity hub nodes, which Phase 3 traversal can use as bridges between facts of different entities. Both follow 2a-D6: best-effort, never block or fail a write. **Rejected:** all-pairs within a session (unbounded growth); amending the spec to drop write-time edges (the user decided to build, 2026-06-10).

## 6. Schema / API changes

- **New table `attend_log`**: `id`, `tenant_id`, `session_id`, `agent_id`, `surface`, `fact_count`, `rule_count`, `already_present`, `injected_chars`, `injected_tokens_est`, `suppressed_tokens_est`, `latency_ms`, `created_at`. Index on `(tenant_id, created_at)`.
- **New table `metric_counters`**: `name` (pk), `value`, `updated_at`.
- **Migration on `source_reliability`**: add `tenant_id` not null default `'default'`; PK becomes `(tenant_id, source)`.
- **`writeFact`** input gains optional `confidence`; D7 formula applied at write.
- **`knowledge_edges`**: no schema change — `co_write` and `about` are new `relation` values.
- **MCP server**: optional Streamable HTTP transport; two env-gated alias tools. Tool list otherwise unchanged.
- **SQL views** (in a migration or `scripts/`): attends/day, suppression rate, avg injection tokens, avg latency, escalations by status, reliability distribution.

## 7. Acceptance criteria

- [ ] With `IRANTI_HTTP_TOKEN` + `IRANTI_HTTP_PORT` set, the full tool list works over Streamable HTTP with the token; requests without the token are rejected; stdio behavior is byte-identical to Phase 2.
- [ ] A fact written via stdio surfaces in an attend served over HTTP (one store, two transports).
- [ ] With `IRANTI_EXPOSE_OPENAI_ALIASES=true`, `search` and `fetch` appear and conform to the connector schema; without it they are absent.
- [ ] Every attend writes an `attend_log` row with non-zero sizes and a latency; attend latency itself is unchanged (logging is off the response path).
- [ ] `already_present` suppression is persisted and queryable: "tokens saved this week" is answerable with one SQL query.
- [ ] Comprehension counters survive a server restart.
- [ ] An extracted fact stores confidence ≈ 0.85 × reliability multiplier, not 1.0; an explicit write from a neutral source still stores 1.0.
- [ ] `source_reliability` rows are tenant-scoped; existing rows migrated to `default`.
- [ ] Two facts written in the same session are linked by a `co_write` edge; every written fact has an `about` edge to its entity; a failed edge write never fails the fact write.
- [ ] Full suite + smoke green; new smoke checks for HTTP round-trip and attend_log.

## 8. Deltas from the master PRD

Pulls the single-user slice of master Phase 5 (hosts/HTTP) forward, consistent with the Phase 1 MCP pull-forward. Implements §11's operational metrics and the recall proxies' data layer. Completes the three §12 Phase 2 leftovers (confidence weighting, write-time edges) and the tenancy seam omission. Token-*budgeted* injection is explicitly deferred to Phase 3 (D3) — §3's token-cost goal is measured here, enforced there.

## 9. Risks & open questions

- **Public endpoint exposure.** A static bearer token is a single secret guarding the whole memory store. Mitigations: HTTP off by default, docs push Cloudflare Tunnel/TLS, token only via env, rate limiting noted as Phase 5 work. Accepted for single-user.
- **`attend_log` growth.** One row per attend is small, but unbounded. The Archivist (Phase 4) gains a retention sweep; until then row count is itself a health-view metric.
- **`co_write` noise.** Same-session writes can be topically unrelated (a session that touches two projects). Low weight (0.5) bounds the damage; Phase 4 edge decay prunes; watch in health views.
- **Confidence semantics shift.** Facts written by extractors will now carry <1.0 confidence; nothing currently *reads* confidence for ranking, so behavior is unchanged until Phase 3/4 consume it — which is exactly the decay-columns play from Phase 0. Verified: no current read path filters on confidence.
- **Q1:** should `attend_log` also count *write-side* activity (facts written per session) for the §11 "fact count per project over time" metric, or is that derivable from `facts.updatedAt`? Lean: derivable — skip the column, add a view.

## 10. Verification

- Unit/integration: HTTP transport auth (accept/reject), alias gating, attend_log row shape + latency unaffected (timing assertion), counter persistence across a simulated restart, D7 formula cases (neutral/trusted/distrusted source), tenant-scoped reliability, `co_write`/`about` edge creation + write-failure isolation.
- Smoke: HTTP round-trip (write over stdio, read over HTTP), attend_log row visible after attend, aliases present only when gated.
- `pnpm build` clean; full vitest green; smoke green.

## Changelog
- 2026-06-10 — proposed (scope set by NF: original CORE-12/13/14 + strategic-review gaps 1–3 as CORE-27/28/29; gaps 4–5 become gated reminders, not 2.5 scope — AGE decision at Phase 3, self-awareness verification at 2.5 close)
- _pending_ — accepted
- _pending_ — shipped
