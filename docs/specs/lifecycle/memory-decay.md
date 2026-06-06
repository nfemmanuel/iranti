# Memory decay

**Status:** template  
**Group:** Memory lifecycle · **Phase:** 4  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Fact confidence decreases over time if the fact is not accessed, calibrated by a stability score.

## Why it matters

Stale facts should fade naturally rather than persisting indefinitely at full weight. A fact established two years ago that has never been accessed is less reliably current than one accessed this morning. The decay model makes this automatic.

## How it works

Every fact has two fields that govern decay:
- `lastAccessedAt` — updated every time the fact is retrieved
- `stabilityScore` — a value that slows or speeds the decay rate for that fact

The Archivist runs the decay calculation on its maintenance cycle. For each active fact, it computes the new confidence based on time since last access and stability score. Facts that fall below the minimum threshold are archived.

Protected facts are entirely exempt from decay.

## The relationship with Hebbian reinforcement

Decay and [Hebbian reinforcement](hebbian-reinforcement.md) operate at different levels. Decay operates on individual fact confidence. Hebbian reinforcement operates on the strength of edges between facts. A fact that is frequently co-retrieved stays confident because its `lastAccessedAt` is updated regularly. The edges between it and its co-retrieved neighbours also strengthen. Both tracks run simultaneously.

## User stories

- As an operator, I want old, unused facts to gradually lose confidence so that they do not pollute retrieval results with stale information.
- As a developer, I want facts I regularly use to stay at high confidence without manual intervention.

## Acceptance criteria

- [ ] Every active fact has a `lastAccessedAt` timestamp updated on retrieval
- [ ] Every fact has a `stabilityScore` that modulates decay speed
- [ ] The Archivist recalculates confidence for all non-protected active facts on its maintenance cycle
- [ ] Facts below the minimum confidence threshold are archived, not deleted
- [ ] Protected facts are excluded from decay entirely
- [ ] The decay formula is documented and defensible

## Technical notes

_Fill in when ready to build (Phase 4). Cover: decay formula (likely exponential based on time delta and stability score), minimum confidence threshold value, how Archivist applies decay in batch, performance on large knowledge stores._

## Dependencies

- Fact storage in place (Phase 1) — needs `lastAccessedAt` and `stabilityScore` fields from Phase 0 schema
- Archivist in place (Phase 4)

## Related specs

- [Hebbian reinforcement](hebbian-reinforcement.md) — parallel track; edge strength vs. fact confidence
- [Archive](archive.md) — decayed facts move to archive
- [Fact storage](../memory-storage/fact-storage.md) — decay fields on the fact schema
