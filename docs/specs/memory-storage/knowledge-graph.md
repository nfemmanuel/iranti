# Knowledge graph

**Status:** template  
**Group:** Memory and storage · **Phase:** 2  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Facts are nodes in a traversable graph with automatically inferred relationships.

## Why it matters

Related facts that share no explicit connection can still be found together through traversal. A similarity search alone can only match what was directly asked for. The graph surfaces what was implicitly connected by how it was learned.

## How relationships form

Connections between facts form automatically based on three signals:
1. **Temporal co-occurrence** — facts written in the same session segment are connected
2. **Entity overlap** — facts about the same entity or related entities are connected
3. **Semantic similarity** — facts whose content is semantically related are connected

These are inferred at write time by the Librarian. They are not static — [Hebbian reinforcement](../lifecycle/hebbian-reinforcement.md) strengthens edges that are retrieved together, and weak edges that prove useless fade over time.

## The graph backend abstraction

The graph layer sits behind a [GraphBackend interface](../../technical/graph-backend-interface.md). Two implementations sit behind it:
- **PostgreSQL implementation** — recursive CTEs on the relationship table. Built in Phase 2. Active from the start.
- **Apache AGE implementation** — PostgreSQL extension with native graph capabilities and Cypher query language. Built in parallel from Phase 2. Activated via config change when the manual implementation shows limits.

## User stories

- As a developer, I want the agent to surface facts that were connected by when and how they were learned, not just by keyword matching.
- As an agent builder, I want to query the graph to answer questions like "what else was related to that decision" without having defined those relationships upfront.

## Acceptance criteria

- [ ] Every fact written creates a graph node
- [ ] Relationships between co-occurring and entity-overlapping facts are created automatically at write time
- [ ] The PostgreSQL implementation can traverse relationships using recursive CTEs
- [ ] Graph traversal retrieval returns facts connected to a starting fact up to N hops
- [ ] Hebbian reinforcement updates edge confidence on co-retrieval
- [ ] The AGE implementation satisfies the same GraphBackend interface as the PostgreSQL implementation

## Technical notes

_Fill in when ready to build (Phase 2). Cover: relationship table schema, CTE structure for traversal, GraphBackend interface contract, AGE schema._

## Dependencies

- Schema design complete (Phase 0) — relationship table must be designed from the start
- GraphBackend interface defined (Phase 0)
- Fact storage in place (Phase 1) — nodes before edges
- Librarian write path (Phase 2) — creates edges when writing facts

## Open questions

From [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items):

**Automatic relationship inference quality.** The graph builds connections automatically from temporal co-occurrence, entity overlap, and semantic similarity. The risk is noise — spurious connections that accumulate and degrade traversal quality. The initial inference rules need to be tight enough that the graph starts clean.

## Related specs

- [Fact storage](fact-storage.md) — facts are graph nodes
- [Hebbian reinforcement](../lifecycle/hebbian-reinforcement.md) — edges strengthen through use
- [Graph traversal retrieval](../retrieval/graph-traversal-retrieval.md) — how the graph is queried
- [Graph backend interface](../../technical/graph-backend-interface.md) — the interface both implementations satisfy
- [Graph backend abstraction](../integration/graph-backend-abstraction.md) — integration feature spec
