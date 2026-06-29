# PRD: Phase 2b — The Librarian (intelligence on the write path)

**Status:** shipped
**Phase:** 2b · **Date:** 2026-06-10 · **Shipped:** 2026-06-10 · **Author:** Claude (with NF)
**Related:** master PRD §6 (the Librarian), §9 (intelligence: conflict detection, source reliability, autonomous write routing); specs [conflict-detection](../../specs/lifecycle/conflict-detection.md), [source-reliability](../../specs/intelligence/source-reliability.md), [autonomous-write-routing](../../specs/intelligence/autonomous-write-routing.md); backlog CORE-9/10/11; audit `goals_audit_2026_06` divergence 3; `oss_llm_extractor_research_2026_06`

---

## 1. Summary

Phase 2b gives iranti judgment on the write path. Three things land: **(1) semantic extraction** — a heuristic code baseline plus an *optional, async, local* open-source LLM pass behind a pluggable `ExtractorBackend` — which begins shifting write autonomy off the agent's tools; **(2) conflict detection and resolution** — a minimal deterministic version (same-key + confidence/source gap → supersede or escalate) and a deeper semantic version that doubles as a comprehension metric; **(3) source reliability scoring**. The governing principle, set by the build philosophy: **code does the heavy lifting, the LLM works underneath** — and the LLM only ever *proposes* facts. Conflict resolution stays fully deterministic and auditable.

## 2. Problem & motivation

**The agent-passive gap (audit divergence 3).** iranti ships 9 tools, 6 agent-driven, against a master-PRD vision (§6) where *"the agent does not call write tools manually."* v0's documented failure was exactly this: agents forget to write, and the store goes stale. The bridge is server-side extraction — iranti captures signal from the stream itself, so the agent's write tools become escape hatches rather than the primary path. Phase 2b starts that shift.

**The Librarian does not exist yet.** Master PRD §6 defines a component that chunks signal into atomic facts, detects conflicts, resolves what it can, escalates what it cannot, and maintains source reliability so trusted sources carry more weight automatically. None of that judgment is built — every fact today is taken at face value.

**Comprehension is unmeasured.** The user's insight: deep conflict detection is not just hygiene, it is a *signal of understanding*. If iranti can reliably tell when two facts genuinely contradict, that is evidence it comprehends the content it stores — a real product metric, not just a cleanup pass.

## 3. Goals & non-goals

**Goals**
- A heuristic semantic-extraction baseline (always on, deterministic, free).
- An optional async local-LLM extraction pass behind a pluggable `ExtractorBackend`, config-gated, that degrades gracefully to heuristic-only.
- Minimal conflict detection: same-key conflicting write → confidence/source gap → supersede or escalate to a markdown file.
- Deep semantic conflict detection wired as a **comprehension metric** (flags candidate contradictions, emits a measurement; does not auto-resolve).
- Source reliability scoring applied as a confidence weight on write.
- The LLM proposes facts only — never adjudicates.

**Non-goals**
- **LLM in conflict *resolution*** — deterministic only (decision B). The model proposes; it never judges.
- **Embeddings / vector similarity** → Phase 3 (deep conflict detection uses the LLM here, gets stronger with embeddings later).
- **Full autonomous stream observation / drift checks** → Phase 3 (the complete Attendant). 2b extracts from the `message`/`toolResult` it is handed, it does not yet watch the whole stream.
- **Removing the agent write tools** — they remain as escape hatches.
- **`iranti resolve` human-resolution CLI** → Phase 4 (the Archivist applies resolved escalations).

## 4. Scope

**In**
- `ExtractorBackend` interface; `HeuristicExtractor` (decision/preference markers); optional `LocalLlmExtractor` (Ollama / OpenAI-compatible endpoint), async, config-gated.
- Extraction wired into `attend`'s write side (`message` + optional `toolResult`), running off the response path.
- Conflict detection module: minimal (same-key) + deep (cross-key semantic, metric-emitting).
- `source_reliability` table + scoring applied on write.
- Escalation-file writer (markdown, for human review).
- Comprehension-metric counters.
- Tests + smoke.

**Out (deferred)**
- Vector similarity (3), `iranti resolve` (4), AGE, cloud.

## 5. Design decisions & rationale

- **D1 — `ExtractorBackend` interface; heuristic default + optional LLM → why (build philosophy + Q1):** code does the heavy lifting (a deterministic marker-based extractor is always on and free), the LLM works underneath (an optional pass catches the semantic facts the regex misses). Pluggable so the model swaps — current pick **Qwen3-4B-class or Gemma 3/4 4B-class via Ollama** (Apache-2.0, tool-calling, runs on consumer hardware) — or falls back to an API. Selected by env (`IRANTI_EXTRACTOR=heuristic|local|api`). **Rejected:** LLM-required (raises the install bar past the already-real Postgres prerequisite); LLM-only (cost/latency, and it betrays the §2 principle that iranti *is not itself an LLM*).

- **D2 — LLM extraction is async, off the response path → why:** it preserves the "negligible overhead" principle. `attend` returns immediately; the extraction pass runs in the background and writes facts that surface on the *next* `attend`. The agent never waits on the model. **Rejected:** synchronous extraction (a latency hit on every single turn).

- **D3 — the LLM proposes facts; it never adjudicates conflicts (decision B) → why:** keep the model's surface tiny and auditable. Its output is *candidate facts* that flow through the exact same write path as any other write — including conflict detection. Resolution stays deterministic (confidence gap + source reliability) so every outcome is explainable and reproducible. **Rejected:** LLM-as-judge (opaque, non-reproducible, expensive, and it would make the store's consistency depend on a model's mood).

- **D4 — minimal conflict detection: same-key gap check → why:** a write to an existing `(entity, key)` with a *different* value triggers a gap check. If the new write's source reliability/confidence exceeds the incumbent by a threshold, supersede (today's behaviour). Otherwise, write an escalation markdown file and keep the existing value pending review. Deterministic, debuggable, matches v0 and master §6. **Rejected:** auto-pick-newest (silently discards possibly-correct information).

- **D5 — deep conflict detection as a comprehension metric (decision A, lands in 2b) → why (user):** detecting *cross-key* contradiction (two differently-keyed facts that cannot both be true) is evidence iranti understands content, not just stores it. Implemented as a detection pass (heuristic + the optional LLM) that **flags** candidate contradictions for escalation and **emits a metric** (contradictions detected, escalation rate, later: agreement with human resolution). It informs and escalates; it does not auto-resolve. Viable in 2b on the LLM extractor; strengthened by embeddings in Phase 3. **Rejected:** waiting for Phase 3 — the user wants the comprehension signal earlier, and the LLM pass makes it possible now.

- **D6 — source reliability scoring → why (master §6):** a `source_reliability(source, wins, losses, score)` table. Each conflict resolution increments the winner and loser; `score` is a smoothed `wins / (wins + losses)`. Applied as a confidence weight on subsequent writes, so sources that consistently win earn trust automatically — no configuration. **Rejected:** static per-source trust config (does not learn from real track record).

- **D7 — escalation via markdown files in a folder → why:** matches v0 and master §6. Unresolvable conflicts become reviewable markdown; a human resolves them; the Phase 4 Archivist applies the resolution via `iranti resolve`. **Rejected:** DB-only escalation (less reviewable, no natural human workflow).

## 6. Schema / API changes

- **New table `source_reliability`** (migration `0004`): `source` (pk), `wins`, `losses`, `score`, `updated_at`.
- **New table `escalations`** (or a `conflictLog` JSON column on `facts`) mirroring the markdown files for queryability — **open (Q-impl-1)**; lean: a lightweight `escalations` table + markdown mirror.
- **`src/extract/`** — `ExtractorBackend` interface, `HeuristicExtractor`, optional `LocalLlmExtractor`.
- **`attend`** write side calls the extractor asynchronously after the response.
- Conflict detection runs inside the existing `writeFact` path (it already serializes via the Phase 2a advisory lock).
- No change to the core fact *read* path.

## 7. Acceptance criteria

- [ ] With `IRANTI_EXTRACTOR=heuristic`, a stated decision/preference in a message ("we decided to use X", "I always want Y") is extracted into a fact tagged with an extractor source.
- [ ] With `IRANTI_EXTRACTOR=local`, extraction routes to a configured Ollama model asynchronously; the decision surfaces as a fact on the **next** `attend`; with no model reachable, it degrades to heuristic with no error and no latency penalty.
- [ ] A same-key conflicting write with an insufficient confidence/reliability gap creates an escalation file and preserves the existing value; a sufficient gap supersedes.
- [ ] `source_reliability` updates on each resolution and weights subsequent writes.
- [ ] A planted cross-key contradiction is flagged by the deep pass and emits the comprehension metric **without** auto-resolving.
- [ ] The LLM is never invoked in the resolution path (resolution is deterministic — auditable in code).
- [ ] Full suite + smoke green.

## 8. Deltas from the master PRD

Implements master §6 (Librarian) and §9 (intelligence) within executed Phase 2b. The agent-passive shift **starts** here (server-side extraction) but **completes** in Phase 3 (full stream observation, the complete Attendant) — the agent write tools remain escape hatches, not removed. Deep conflict detection is pulled **earlier** than a pure-embeddings approach would allow, per the user's call, by riding on the LLM extractor instead of waiting for Phase 3 vectors.

## 9. Risks & open questions

- **Extraction precision.** A wrong extracted fact poisons retrieval. Mitigated by conservative heuristics, the "wrong facts are worse than missing facts" principle (tune precision over recall), extractor-source tagging (identifiable and bulk-cleanable), and the LLM being optional. This is the single most consequential quality knob in the phase.
- **LLM cost/latency if misconfigured.** Mitigated by async + off-by-default + graceful degradation.
- **Deep-conflict false positives** create escalation noise. Mitigated by treating the output as a flag/metric, never auto-resolution.
- **The comprehension metric needs a ground-truth contradiction set** to be meaningful — open; likely a small curated eval fixture.
- **Q-impl-1:** escalations as a table + markdown mirror, or markdown only? Lean: table + mirror, for queryability.

## 10. Verification

- Extractor unit tests (heuristic markers); optional-LLM integration test against a mocked backend; conflict-detection tests (supersede vs escalate); source-reliability tests; a deep-conflict metric test with a planted cross-key contradiction; smoke addition.
- `pnpm build` clean; full vitest green; smoke green.

## Changelog
- 2026-06-10 — proposed
- 2026-06-10 — accepted (decisions: A — deep conflict detection in 2b; B — LLM proposes facts only, resolution deterministic; Q1 — heuristic baseline + optional async local OSS LLM behind a pluggable, config-gated `ExtractorBackend`)
- 2026-06-10 — shipped (commit 5053ab4f, +fix 9f2bc0dc; conflict detection + source reliability + semantic extraction)
