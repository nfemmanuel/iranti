# Two-pass retrieval

**Status:** template  
**Group:** Retrieval · **Phase:** 3  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Primary pass for directly relevant facts, secondary pass for peripheral facts that might matter.

## Why it matters

The answer to a question often depends on context the question did not explicitly ask for. A single-pass retrieval misses the periphery. Two passes with different thresholds give the agent a richer, more honest picture of what is known.

## How the two passes work

**Primary pass** — Retrieves facts that are directly relevant to the current query or task. High relevance threshold. These are surfaced confidently.

**Secondary pass** — Retrieves facts that scored lower but could still be useful at the edges of the current context. Lower threshold. These are surfaced with appropriate weighting to signal they are peripheral, not primary.

Both passes are surfaced to the agent. The host needs to know how to handle two tiers of results.

## User stories

- As an agent, I want to receive both central and peripheral context so that I have the full picture without noise dominating.
- As an agent builder, I want to know which facts are primary and which are peripheral so that I can present them appropriately.

## Acceptance criteria

- [ ] Retrieval runs two passes with distinct relevance thresholds
- [ ] Primary results are marked as primary; secondary results are marked as peripheral
- [ ] Both tiers are returned to the caller with enough metadata to distinguish them
- [ ] The weighting of secondary results relative to primary is configurable
- [ ] Secondary pass does not significantly increase latency (can run in parallel with the Attendant's post-retrieval logic)

## Technical notes

_Fill in when ready to build (Phase 3). Cover: threshold values, how passes are run (parallel or sequential), result schema, how tiers are communicated to the host._

## Dependencies

- Fact storage in place (Phase 1)
- Attendant retrieval side in place (Phase 3)

## Open questions

From [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items):

**Retrieval pass weighting and presentation.** How the two tiers are weighted relative to each other and how they are presented back to the agent has not been decided. Whether they arrive together with different confidence scores, in separate blocks, or as a merged set with metadata indicating tier needs a design decision before Phase 3.

## Related specs

- [Reactive retrieval](reactive-retrieval.md) — triggers that start the retrieval process
- [Periodic drift check](periodic-drift-check.md) — the other retrieval trigger
- [Context window observation](context-window-observation.md) — runs after retrieval, before injection
- [Graph traversal retrieval](graph-traversal-retrieval.md) — can augment both passes
