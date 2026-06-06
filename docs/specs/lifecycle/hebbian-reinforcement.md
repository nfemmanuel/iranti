# Hebbian reinforcement

**Status:** template  
**Group:** Memory lifecycle · **Phase:** 2  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Graph edges between facts strengthen when those facts are retrieved together.

## Why it matters

Frequently co-accessed facts become easier to find together over time. The graph learns from usage — paths that matter surface earlier in future retrievals, and spurious connections that never prove useful fade out naturally.

## The principle

This is a direct application of Hebb's principle from neuroscience: neurons that fire together wire together. In iranti's context: facts recalled together are strengthened together.

The inverse holds equally. If two facts exist but are never retrieved together, their connection stays weak or never forms. Relationships are earned through use, not just inferred at write time. This keeps the graph clean over time without any manual pruning.

## How it works

When the Attendant retrieves a set of facts together to answer a query or provide context, it records that co-access event. The graph edges between those facts gain confidence. Edges that are traversed repeatedly build up over time. Edges that form at write time but are never subsequently traversed fade.

The Archivist applies edge decay on its maintenance cycle, mirroring how it applies fact confidence decay.

## User stories

- As a developer using iranti over months, I want the facts I regularly work with together to surface faster and more reliably as a group over time.
- As an agent, I want graph traversal to prioritise paths that have proven useful rather than treating all connections equally.

## Acceptance criteria

- [ ] Co-retrieval events are recorded on the graph edges between co-retrieved facts
- [ ] Edge confidence increases on co-retrieval
- [ ] Edge confidence decreases over time if co-retrieval stops (via Archivist decay)
- [ ] Graph traversal retrieval orders results by edge confidence
- [ ] The Attendant records co-access without the agent being aware of it

## Technical notes

_Fill in when ready to build (Phase 2). Cover: how co-access is recorded (batch at end of retrieval, or per-pair), edge confidence update formula, edge decay model, interaction with the GraphBackend interface._

## Dependencies

- Knowledge graph in place (Phase 2)
- GraphBackend interface defined (Phase 0) — edge confidence updates must go through the interface
- Archivist (Phase 4) — for edge decay

## Related specs

- [Knowledge graph](../memory-storage/knowledge-graph.md) — the graph whose edges are strengthened
- [Memory decay](memory-decay.md) — parallel track; individual fact confidence vs. edge strength
- [Graph traversal retrieval](../retrieval/graph-traversal-retrieval.md) — traversal uses edge confidence to rank paths
- [Graph backend interface](../../technical/graph-backend-interface.md) — interface for edge updates
