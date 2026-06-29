# PRD: Phase 2a — Graph Foundation & Write Safety

**Status:** shipped
**Phase:** 2a · **Date:** 2026-06-10 · **Author:** Claude (with NF)
**Related:** master PRD §6 (Librarian), §7 (facts as a graph / Hebbian), §12 (Phase 2); specs [knowledge-graph](../../specs/memory-storage/knowledge-graph.md), [graph-backend-abstraction](../../specs/integration/graph-backend-abstraction.md), [graph-traversal-retrieval](../../specs/retrieval/graph-traversal-retrieval.md), [hebbian-reinforcement](../../specs/lifecycle/hebbian-reinforcement.md); backlog CORE-5/6/7/8; audit `goals_audit_2026_06` divergence 2

---

## 1. Summary

Phase 2a lays the graph substrate and makes writes safe — no intelligence yet. It adds a `knowledge_edges` table behind a `GraphBackend` interface (with a PostgreSQL recursive-CTE implementation), records **co-access edges every time `attend` returns facts together** so the learned relevance index starts training on day one, creates `governs` edges from rules to the facts they co-fire with, and closes the Phase 1 concurrent-write race with PostgreSQL advisory locks. This is pure substrate and safety: it unblocks Phase 2.5 (HTTP invites concurrency) and Phase 3 (two-pass retrieval consumes the graph).

## 2. Problem & motivation

Three forces converge here.

**The graph is the relevance engine (audit divergence 2).** The master PRD's Hebbian model (§7) is *edge* strengthening on co-access: facts retrieved together get a stronger connection, and strong edges become a learned index of "what is historically useful together" — no embeddings or LLM call at retrieval, and it improves with use. The critical consequence: **every turn without edge recording is lost training data.** This is the same argument that put the decay columns in the schema at Phase 0 — the signal must start accumulating before the feature that consumes it ships.

**The Phase 1 write race must close before HTTP.** Phase 1 made no concurrent-write guarantee: two writes to the same `(tenant, entity, key)` can both pass the protection check and both snapshot to `fact_archive`, producing duplicate history. Phase 2.5's remote endpoint invites phone+laptop concurrency, so this has to be fixed first.

**The `GraphBackend` seam was specced but never built.** The master PRD mandates a graph interface (so the Apache AGE swap is a config change, not a rewrite) and lists it as Phase 0 — it is still a `template`. The Librarian and Attendant must call only the interface.

## 3. Goals & non-goals

**Goals**
- A `knowledge_edges` table and a `GraphBackend` interface with a working PostgreSQL recursive-CTE implementation.
- Co-access edges recorded on every `attend` that returns ≥2 facts — **asynchronously, off the response path**, so attend latency is unchanged.
- `governs` edges from a rule to the facts it co-fires with.
- Write serialization that eliminates the duplicate-archive race.
- A bounded traversal query (`getNeighbors`) ready for Phase 3 to consume.

**Non-goals**
- **Graph traversal *in retrieval*** (two-pass) → Phase 3. 2a records and exposes edges; it does not yet rank with them.
- **Semantic-similarity edges** (need embeddings) → Phase 3.
- **Edge decay / pruning** (the inverse Hebbian) → Phase 4.
- **Apache AGE implementation** → parallel track, swap when the CTE version shows limits.
- **Any LLM, conflict detection, source reliability** → Phase 2b.

## 4. Scope

**In**
- Drizzle migration for `knowledge_edges`.
- `GraphBackend` interface + `PostgresGraphBackend` (recursive CTE): `addEdge`, `reinforceEdge`, `getNeighbors`, `getEdge`.
- `attend` records all-pairs co-access among returned facts, async after the response is built.
- `governs` edges created when a rule is injected alongside facts in the same `attend`.
- Advisory lock in `writeFact`.
- Tests + smoke additions, including a concurrency regression test.

**Out (deferred)**
- Traversal-in-retrieval (3), embedding edges (3), edge decay (4), AGE (parallel), conflict detection / source reliability / extraction (2b).

## 5. Design decisions & rationale

- **D1 — `knowledge_edges`, generic typed edges → why:** one table holds every edge kind. Columns: `id, tenant_id, source_type, source_id, target_type, target_id, relation, weight, co_access_count, created_at, last_reinforced_at`. Typed endpoints (`fact | rule | entity`) let the same table carry fact↔fact co-access, rule→fact `governs`, and future entity edges. Co-access pairs are stored **canonically** (order the two ids so `(A,B)` and `(B,A)` collapse to one row). **Rejected:** a table per edge type (proliferation); a JSON adjacency list on `facts` (not queryable, no traversal).

- **D2 — `GraphBackend` interface first, CTE implementation behind it → why:** the Librarian and Attendant must depend on the interface, never on SQL, so the Apache AGE swap is a config change. Methods: `addEdge(edge)`, `reinforceEdge(a, b, relation, delta)`, `getNeighbors(nodeId, {depth, minWeight, limit})`, `getEdge(a, b, relation)`. **Rejected:** calling SQL directly from `attend` (couples retrieval to storage, kills the swap story).

- **D3 — co-access = all-pairs among returned facts, async, idempotent upsert → why:** with the cap at 20 facts, all-pairs is ≤190 edges — trivial. It runs **after** the response is assembled (fire-and-forget) so attend latency is untouched. The upsert increments `weight` and `co_access_count` and sets `last_reinforced_at`; canonical ordering prevents duplicate rows. **Rejected:** star-from-primary (loses pairwise signal); synchronous recording (adds latency to every turn).

- **D4 — `governs` edges rule→fact → why:** when a rule is injected in the same `attend` as a set of facts, strengthen a directed `governs` edge from the rule to each fact. This is the groundwork for graph-proximity rule triggering — later a rule can surface because its governed facts surfaced. Purely additive. **Rejected:** nothing; no downside.

- **D5 — write safety via `pg_advisory_xact_lock(hashtext(tenant|entity|key))` → why:** serialize writes to the same *logical* fact for the duration of the transaction, covering the create-or-update window where two writers would both snapshot. No schema change, no new infrastructure. **Rejected:** `SELECT … FOR UPDATE` (the row may not exist yet on first insert, so there is nothing to lock); a table-level lock (far too coarse, kills throughput).

- **D6 — edges are best-effort and never block or fail a read/write → why:** the graph is an enhancement. A failed edge insert must never break `attend` or `writeFact`. All edge writes are wrapped and log to stderr on failure. **Rejected:** transactional coupling (a graph bug would take down core memory — unacceptable).

- **D7 — weights are raw accumulation now; normalization deferred → why:** 2a only *accumulates* signal. How weight maps to retrieval ranking is Phase 3's decision, made when retrieval actually consumes it. Store `co_access_count` plus a `weight` float we can recompute later. **Rejected:** premature weight normalization before we know the consumer.

## 6. Schema / API changes

- **New table `knowledge_edges`** (Drizzle migration `0003`), with a unique constraint on `(tenant_id, source_type, source_id, target_type, target_id, relation)` and an index on `(source_type, source_id)` for neighbour lookups.
- **`src/graph/`** — `GraphBackend` interface + `PostgresGraphBackend`.
- **`attend`** gains an async post-response edge-recording step (co-access + governs).
- **`writeFact`** gains one advisory-lock line at the top of its transaction.
- No change to `facts`, `rules`, `fact_archive`, `entities`, etc.

## 7. Acceptance criteria

- [ ] `knowledge_edges` migration applies; canonical-pair uniqueness enforced.
- [ ] `PostgresGraphBackend` implements `addEdge`, `reinforceEdge`, `getNeighbors`, `getEdge` against the interface.
- [ ] After an `attend` returning ≥2 facts, co-access edges among them exist with `co_access_count ≥ 1`; a second identical `attend` **increments** the count, does not duplicate the row.
- [ ] A rule injected alongside facts creates `governs` edges rule→fact.
- [ ] `getNeighbors(factId, {depth: 1, minWeight})` returns the co-accessed facts.
- [ ] **Concurrency regression:** two simultaneous writes to the same `(entity, key)` produce exactly one archive snapshot per real value change — the Phase 1 race is closed.
- [ ] Edge-recording failure never fails `attend`; lock contention serializes without deadlock.
- [ ] `attend` latency is unchanged (edges recorded async).
- [ ] Full suite + smoke green.

## 8. Deltas from the master PRD

Aligns with master Phase 2 (Librarian + graph) but deliberately ships the graph **substrate** without the Librarian's intelligence — a finer split than §12 (intelligence is 2b). "Co-access from day one" is the audit's reframe made concrete: edges are a *relevance index*, not decoration, so capture cannot wait for the consumer. Hebbian reinforcement here is edge-weight increment on co-access (the correct master §7 meaning); the fact-`stabilityScore` reading in `implementation.md` is reconciled at Phase 4 (DEBT-4).

## 9. Risks & open questions

- **Edge growth.** High-traffic entities accumulate edges. Mitigated by canonical-pair dedup (one row per pair) and future edge decay (Phase 4) pruning weak edges; watch row count as an operational metric.
- **Garbage-in.** Co-access from a low-relevance `attend` trains weak/bad edges — graph quality is downstream of retrieval quality. Mitigated by the 1.1/1.2 relevance improvements and by later decay; acceptable for 2a.
- **Advisory-lock hash collisions.** `hashtext` collisions would over-serialize two unrelated keys — astronomically rare and harmless (a tiny, transient lock wait). Acceptable.
- **Open:** the weight formula (raw count vs log vs time-decayed) is deferred to Phase 3, when retrieval consumes it.

## 10. Verification

- Migration test; `GraphBackend` unit tests; `attend` co-access integration test; `governs`-edge test; the **concurrency regression test** (the headline); smoke addition asserting edges form across two attends.
- `pnpm build` clean; full vitest green; smoke green.

## Changelog
- 2026-06-10 — proposed
- 2026-06-10 — accepted (split from Phase 2; scope settled — graph substrate + write safety, no intelligence)
- 2026-06-10 — shipped (commit 1f7af277; GraphBackend + advisory-lock write safety + co_access/governs edges)
