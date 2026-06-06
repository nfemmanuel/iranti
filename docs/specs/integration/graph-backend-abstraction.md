# Graph backend abstraction

**Status:** template  
**Group:** Integration · **Phase:** 0  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

The graph layer sits behind a shared interface with two implementations: one using PostgreSQL recursive CTEs and one using Apache AGE.

## Why it matters

Keeps the initial build simple while making migration to a dedicated graph backend a configuration change rather than a rewrite. The Librarian and Attendant call only the interface — they are never aware of which implementation is active.

## The two implementations

**PostgreSQL implementation (Phase 2, primary)**  
Uses recursive CTEs — a standard SQL technique for querying hierarchical and connected data — on the existing relationship table in PostgreSQL. This is the implementation that ships with the initial build. It is functional and correct for the early-stage knowledge store.

**Apache AGE implementation (parallel track)**  
Apache AGE is a PostgreSQL extension that adds native graph database capabilities and a graph query language called Cypher. It does not need to be active at Phase 2, but development starts in parallel with Phase 2 so the interface is validated and the switch is ready when needed. Activation is a config change and a migration.

## What the interface must define

The [GraphBackend interface](../../technical/graph-backend-interface.md) defines all operations both implementations must satisfy:
- Create a vertex (fact node)
- Create an edge (relationship between facts)
- Update edge confidence (Hebbian reinforcement)
- Traverse from a starting node to depth N
- Query edges by entity
- Archive a vertex

Both implementations must satisfy this interface completely. If the interface is called with a method the implementation does not support, it errors explicitly — no silent fallbacks.

## User stories

- As a developer building iranti, I want to swap graph implementations via config without touching the Librarian or Attendant code.
- As an operator, I want to know which graph backend is active from `iranti status`.

## Acceptance criteria

- [ ] GraphBackend interface is defined in Phase 0 before either implementation is written
- [ ] PostgreSQL implementation satisfies the full interface
- [ ] Apache AGE implementation satisfies the full interface
- [ ] Switching implementations requires only a config change and migration — no code changes
- [ ] `iranti status` reports which graph backend is active
- [ ] If AGE is not installed, the PostgreSQL implementation is used with no manual fallback required

## Technical notes

_Fill in when ready to build (Phase 0). Cover: interface definition (TypeScript), how the active implementation is selected (config), migration path between implementations._

## Dependencies

- Phase 0: This is a Phase 0 item — the interface must be designed before Phase 2 implementations are written

## Related specs

- [Knowledge graph](../memory-storage/knowledge-graph.md) — the graph the abstraction serves
- [Graph backend interface](../../technical/graph-backend-interface.md) — the technical design document for the interface
- [Graph traversal retrieval](../retrieval/graph-traversal-retrieval.md) — uses the backend for traversal queries
- [Hebbian reinforcement](../lifecycle/hebbian-reinforcement.md) — uses the backend to update edge confidence
