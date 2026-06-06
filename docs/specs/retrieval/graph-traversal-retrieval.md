# Graph traversal retrieval

**Status:** template  
**Group:** Retrieval · **Phase:** 2–3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Retrieval can walk the knowledge graph rather than only matching isolated records.

## Why it matters

Surfaces connections between facts that a similarity search alone would miss. A fact about a decision made in March may be directly connected to a fact written in January through shared entities — even though neither mentions the other. Graph traversal finds those connections.

## How it works

When a query arrives, the Attendant can run graph traversal alongside (or in addition to) similarity search. Starting from the most directly relevant facts, the Attendant walks the graph edges to surface facts that are connected through traversal — potentially reaching facts that would score too low in a similarity search to surface on their own.

The traversal is bounded to prevent runaway queries. Maximum hop depth is configurable.

The [Hebbian reinforcement](../lifecycle/hebbian-reinforcement.md) model means frequently-traversed paths become stronger over time, making the graph more useful as iranti accumulates more real usage.

## User stories

- As a developer, I want iranti to surface facts connected to my current task through relationships, not just keyword similarity.
- As a developer, I want questions like "what else was related to that decision we made last month" to be answerable without my having to remember the exact wording.

## Acceptance criteria

- [ ] Retrieval can walk the graph from a starting set of facts up to a configurable maximum depth
- [ ] Graph traversal results are included in the two-pass retrieval output (as secondary results, or augmenting secondary pass)
- [ ] Traversal is bounded — maximum hop depth has a sensible default and is configurable
- [ ] The PostgreSQL CTE implementation satisfies the [GraphBackend interface](../../technical/graph-backend-interface.md) for traversal queries
- [ ] Traversal co-access triggers Hebbian reinforcement on the edges traversed

## Technical notes

_Fill in when ready to build (Phase 2–3). Cover: traversal query structure (CTE for PostgreSQL, Cypher for AGE), maximum depth default, how traversal results are merged with similarity results, performance characteristics._

## Dependencies

- Knowledge graph in place (Phase 2)
- GraphBackend interface defined (Phase 0)
- PostgreSQL graph implementation in place (Phase 2)

## Related specs

- [Knowledge graph](../memory-storage/knowledge-graph.md) — the graph that is traversed
- [Hebbian reinforcement](../lifecycle/hebbian-reinforcement.md) — traversal strengthens edges
- [Two-pass retrieval](two-pass-retrieval.md) — traversal augments retrieval passes
- [Graph backend interface](../../technical/graph-backend-interface.md) — the interface traversal queries must satisfy
