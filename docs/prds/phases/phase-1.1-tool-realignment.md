# PRD: Phase 1.1 — Tool Realignment

**Status:** shipped (retroactive)
**Phase:** 1.1 · **Date:** 2026-06-10 · **Author:** Claude (retroactive, from implementation record)
**Related:** master PRD §9 (features), [Phase 1 PRD](phase-1-mcp-server.md), [implementation.md](../../engineering/implementation.md)

---

## 1. Summary

Phase 1.1 widens the MCP tool surface from 4 tools to 9 and, more importantly, fixes how `iranti_attend` decides *which* facts to inject. The four Phase 1 tools (`iranti_attend`, `iranti_write`, `iranti_write_rule`, `iranti_archive`) are kept; five retrieval and structured-write tools are added (`iranti_search`, `iranti_checkpoint`, `iranti_history`, `iranti_query`, `iranti_write_issue`). The load-bearing change is in attend: fact ordering moves from pure recency (`updatedAt DESC`) to **keyword relevance scoring** against the user's message, so the injected context is about the current turn rather than whatever was written last. This is the first correction of the recency-ordering divergence the June 2026 audit later named, and it advances attend one rung up the relevance ladder — entity scope → keyword → vector — with vector similarity still owed in Phase 3.

## 2. Problem & motivation

Phase 1 shipped a working MCP server but a thin and partly mis-shaped tool surface. Two concrete gaps motivated this phase.

First, **retrieval was too weak**. The only way to get facts back out was `iranti_attend` (broad, entity-scoped injection). Phase 1 had deliberately deferred search; in practice an agent that knew roughly what it wanted but not the exact key had no way to ask. Exact-match-only retrieval — fetch by `entity + key` or nothing — is not how agents actually reach for memory.

Second, and worse, **attend injected the wrong facts**. It returned each entity's most *recently written* facts, capped. Recency is a poor proxy for relevance: a fact written thirty seconds ago about rate limits would crowd out the UX decision the user is actually asking about. The product's whole premise (master PRD §2: spend tokens only on what helps *this* turn) is undercut if the ranking ignores the turn. The master PRD §9 lists search, query, history, checkpointing and issue tracking as capabilities; none were reachable, and the one retrieval path that existed ranked by the wrong signal.

## 3. Goals & non-goals

**Goals**
- Reinstate explicit retrieval: fuzzy search, exact query, and full change history as first-class tools.
- Promote checkpointing and structured issue tracking from "generic write with a magic key" to dedicated tools whose descriptions teach the agent what to put in them.
- Make attend's fact ordering relevance-driven (keyword overlap with the message) instead of recency-driven, while preserving recency as the fallback when there is no message.
- Hold the line on the existing contract: caps, checkpoint-separate-channel, access tracking, and backward compatibility for callers that pass no message.

**Non-goals**
- **Semantic / vector retrieval.** Keyword overlap is lexical only; embeddings and similarity ranking are Phase 3.
- **Cross-entity relevance ranking.** With multiple entity hints, facts are still grouped by hint order, not globally re-ranked by relevance (see §9).
- **Server-side write autonomy.** This phase adds *more* agent-callable write tools; making iranti write on its own (so the agent rarely has to) is Phase 2. The tension this creates with the master PRD vision is tracked in §8, not resolved here.
- **Schema change.** No new tables or columns (§6).

## 4. Scope

**In**
- Five new tools: `iranti_search`, `iranti_checkpoint`, `iranti_history`, `iranti_query`, `iranti_write_issue`.
- One new library function, `readRelevantFactsByEntity`, and the supporting `searchFacts` full-text query.
- attend swapped from `readRecentFactsByEntity` → `readRelevantFactsByEntity`, with the merge-sort bug fix described in §5.
- Test and stdio-smoke coverage for every new tool and for the keyword-scoring behaviour.

**Out (deferred)**
- Vector / semantic retrieval → Phase 3 (pgvector).
- Cross-entity relevance ranking under multiple hints → Phase 3 (embeddings).
- Server-driven autonomous writes (agent tools become escape hatches) → Phase 2.

## 5. Design decisions & rationale

- **Keyword relevance scoring in attend → why:** recency is the wrong axis for "what helps this turn." `readRelevantFactsByEntity` tokenizes the message (lowercase, split on non-alphanumeric, drop tokens under 3 chars and a small stop-word set), fetches a wider candidate pool (`3× limit`, capped at 50), and scores each candidate by keyword overlap — **a key-token match weights 2×, a value-substring match 1×** — then ranks by score with recency as the tiebreaker. *Alternative rejected:* Postgres full-text / `tsvector` ranking — heavier, and we want the same deterministic, dependency-free scoring everywhere until Phase 3 brings real vectors. *Graceful degradation:* with no message, or a message that tokenizes to nothing, or a candidate pool with zero keyword hits, it falls back to pure recency — so it is never worse than Phase 1.

- **The merge-sort bug fix → why it mattered:** attend fetches facts per entity then flattens and re-sorts the merged list. The original merge sorted by `updatedAt DESC` unconditionally — which **re-sorted the library's relevance ranking back into recency order, silently undoing it.** The fix makes the merge sort conditional: a no-op (`return 0`) when a message is present (each entity's slice is already relevance-ranked by the library), recency-sort only when no message is present. Without this, the relevance work would have been invisible — the most important one-line correction in the phase.

- **`iranti_search` as full-text ILIKE over key + value → why:** the agent often knows the topic but not the exact key. Case-insensitive substring matching across both fields, optionally entity-scoped, is the smallest thing that answers "find me the fact about X." It access-tracks its results because a search hit is a real retrieval. *Alternative rejected:* deferring search again — Phase 1's deferral is exactly what this phase is correcting.

- **`iranti_checkpoint` as a dedicated tool → why:** Phase 1 wrote checkpoints through generic `iranti_write` with the reserved key `checkpoint`. That worked mechanically but told the agent nothing about *what a good checkpoint contains*. The dedicated tool's description instructs the agent to record what is done, what is next, and any blockers — so a fresh session can resume cold. It wraps the same reserved-key mechanism underneath; only one checkpoint per entity, writing a new one archives the prior.

- **`iranti_query` as exact, access-tracked lookup → why:** distinct from search (fuzzy) and attend (broad injection). When the agent knows the entity and key, it should get the current value directly — and because this is a deliberate retrieval, it updates access tracking, feeding the same reinforcement signal as attend. *Why separate from search:* search is a sweep that may miss on exact keys and is ranked by recency; query is a point read with retrieval semantics.

- **`iranti_history` → why:** auditing how a decision evolved requires the archived values, not just the current one. History returns the live value plus the `fact_archive` rows, newest first, resolvable by `factId` or by `entity + key`. This makes the "facts are never hard-deleted" guarantee actually inspectable by the agent.

- **`iranti_write_issue` as structured JSON facts → why:** issues and to-dos are facts with structure (status, priority), and tracking them was a concrete user need (the product owner wanted issue tracking) that generalizes cleanly. Rather than a new table, an issue is stored as a fact with key `issue:<slug>`, where the slug is derived from the title (lowercased, non-alphanumeric runs → hyphens, trimmed, capped at 40 chars) and the value is JSON `{title, description, status, priority}`. **The same title upserts** — so re-filing "Login bug" as `resolved` updates the existing issue instead of forking it. *Alternative rejected:* a dedicated `issues` table — premature; the fact substrate already gives history, provenance, access tracking and archival for free, and keeping issues as facts means they flow through attend and search like everything else.

- **Keep all four Phase 1 tools unchanged → why:** they are the stable primitives. Adding alongside, rather than reshaping, keeps every existing host config working and isolates the one behavioural change (attend's ranking) for clean verification.

## 6. Schema / API changes

**No database schema change.** No new tables, columns, or migrations. Issues reuse the `facts` table.

**Tool surface: 4 → 9.**

| Tool | Status | Shape |
|---|---|---|
| `iranti_attend` | kept (behaviour changed) | now ranks facts by keyword relevance to `message`; internally `readRecentFactsByEntity` → `readRelevantFactsByEntity` |
| `iranti_write` | kept | unchanged |
| `iranti_write_rule` | kept | unchanged |
| `iranti_archive` | kept | unchanged |
| `iranti_search` | **new** | `{ query, entityType?, entityId?, limit? }` → `{ count, results[] }` |
| `iranti_checkpoint` | **new** | `{ entityType, entityId, text, surface? }` → `{ factId, entity, updatedAt }` |
| `iranti_history` | **new** | `{ factId? | (entityType, entityId, key) }` → `{ found, current, history[] }` |
| `iranti_query` | **new** | `{ entityType, entityId, key }` → `{ found, fact }`; access-tracked |
| `iranti_write_issue` | **new** | `{ entityType, entityId, title, description?, status?, priority? }` → `{ factId, entity, key, title, status }` |

New library functions: `readRelevantFactsByEntity(entityType, entityId, limit, message?)` and `searchFacts(query, opts)`. The attend response shape is unchanged in this phase (the `currentContext` / `alreadyPresent` additions are Phase 1.2).

## 7. Acceptance criteria

- [x] Tool surface is exactly 9 registered tools; the four Phase 1 tools are unchanged.
- [x] `iranti_search` finds facts by keyword in key *and* in value, case-insensitively, and honours entity scoping when `entityType + entityId` are given.
- [x] `iranti_query` returns the exact current value for a known `entity + key` and `found: false` otherwise.
- [x] `iranti_history` returns the current value plus archived values newest-first, and reports a clear reason on insufficient input.
- [x] `iranti_checkpoint` saves a checkpoint that `iranti_attend` then surfaces on the checkpoint channel; a second checkpoint replaces the first.
- [x] `iranti_write_issue` stores a JSON fact keyed `issue:<slug>`; the same title upserts (status update lands on the existing fact).
- [x] attend surfaces a topically relevant fact ahead of a more-recently-written off-topic one when a `message` is present.
- [x] attend falls back to recency ordering when no `message` is present (backward compatible with Phase 1).
- [x] The relevance ranking is not undone by the post-merge sort.
- [x] Full vitest suite + stdio smoke green.

## 8. Deltas from the master PRD

The master PRD §9 enumerates these capabilities (search, query, history, checkpoints, issue tracking) but **does not number a "Phase 1.1."** This is an interstitial hardening phase inserted between the Phase 1 MCP server and Phase 1.2 — it is on the record retroactively precisely because it shipped before the PRD-first process existed.

Two deltas worth naming explicitly:

1. **Relevance ladder, partial climb.** The keyword-scoring change is the first correction of the recency-ordering divergence later named in the June 2026 audit. It moves attend up the ladder — *entity scope → keyword → vector* — but only to the middle rung. Vector similarity is still owed in Phase 3; until then a paraphrase that shares no keywords with a fact will not surface it. The delta is the partial scope, called out here rather than left as a silent gap.

2. **Tension with the "agent does not call write tools manually" vision (§6).** Shipping six agent-callable read/write tools sits in tension with the master PRD's intent that iranti observe and write *on its own*, so the agent rarely reaches for a write tool. This is acknowledged, not denied: the resolution is server-side autonomy growing in Phase 2, after which these tools become **escape hatches** — available when the agent has something specific to record or retrieve, but no longer the primary path. The tension is tracked so it is not mistaken for a change of direction.

## 9. Risks & open questions

- **Cross-entity ranking is naive.** With multiple entity hints *and* a message, facts are ordered by entity-hint order, not by cross-entity relevance — each hint's slice is relevance-ranked internally, but the slices are concatenated, not globally merged by score. A highly relevant fact on the second entity can sit below a weakly relevant one on the first. Deferred to Phase 3 (embeddings), where a single similarity score makes a global ranking natural.
- **Keyword overlap is lexical and brittle.** Synonyms, paraphrase, and non-English tokens score zero. The recency fallback bounds the downside (you never get *worse* than Phase 1), but the upside is capped until vectors land.
- **Issue slugs can collide.** Two titles that differ only past 40 chars, or only in punctuation, produce the same `issue:<slug>` and would upsert onto each other. Acceptable for now given the upsert-on-same-title intent; revisit if collisions show up in real use.
- **Open:** should `iranti_query` and `iranti_search` access-tracking be weighted differently from attend's? Both count as retrievals today; whether deliberate point reads should reinforce more strongly than broad injection is a Phase 4 calibration question.

## 10. Verification

- New test groups in `mcp-tools.test.ts` covering `search` (key match, value match, no-match, entity scoping), `iranti_checkpoint` (save-and-surface, replace), `history` (current + archive, not-found, insufficient-input), `query` (exact hit, miss), `write_issue` (store, same-title upsert), and `attend — keyword relevance scoring` (relevant-over-recent, recency fallback when no message).
- **104 / 104 vitest tests passing** and **16 / 16 stdio smoke checks passing** at time of shipping.
- `pnpm build` clean.

## Changelog
- 2026-06-10 — shipped (retroactive). Tool surface 4 → 9 (`iranti_search`, `iranti_checkpoint`, `iranti_history`, `iranti_query`, `iranti_write_issue` added; `iranti_attend`, `iranti_write`, `iranti_write_rule`, `iranti_archive` kept). attend re-ranked by keyword relevance via `readRelevantFactsByEntity`; post-merge sort made conditional to preserve the ranking. No schema change. 104/104 vitest + 16/16 stdio smoke green.
