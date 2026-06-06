# Source reliability scoring

**Status:** template  
**Group:** Intelligence · **Phase:** 2  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Sources earn reliability scores over time based on how often their facts win conflicts.

## Why it matters

Not all sources are equally trustworthy. A source that consistently writes facts that win conflicts — meaning their information proves more accurate and current than competing information — has demonstrated reliability. Weighting should reflect that track record rather than treating all sources equally or requiring static configuration.

## How it works

Every fact carries a source identifier. When the Librarian processes a conflict between two facts from different sources, the outcome is recorded against both sources: the winning source's reliability score increases and the losing source's decreases (or stays flat, depending on the implementation).

When a new fact arrives from a source, the Librarian applies the source's current reliability score as a confidence multiplier on top of the raw confidence assigned by the Attendant. A highly reliable source's facts start with a confidence advantage in conflict resolution.

Over time, sources that consistently provide accurate information build a track record that makes their facts more likely to prevail in future conflicts.

## User stories

- As an operator, I want iranti to automatically give more weight to sources that have proven reliable over time, without my having to configure reliability manually.
- As an operator, I want to inspect source reliability scores to understand which sources iranti trusts most and why.

## Acceptance criteria

- [ ] Every fact carries a source identifier
- [ ] A source registry tracks win/loss records per source
- [ ] Source reliability scores are updated after each conflict resolution
- [ ] The Librarian applies source reliability weighting to incoming fact confidence at write time
- [ ] Source reliability scores are queryable (via CLI or API)
- [ ] A new source starts with a neutral reliability score, not zero

## Technical notes

_Fill in when ready to build (Phase 2). Cover: source registry schema, win/loss tracking algorithm, confidence multiplier formula, starting score for new sources._

## Dependencies

- Fact storage in place (Phase 1)
- Conflict detection in place (Phase 2) — reliability scores update on conflict outcomes

## Related specs

- [Conflict detection](../lifecycle/conflict-detection.md) — conflict outcomes drive reliability score updates
- [Autonomous write routing](autonomous-write-routing.md) — source is assigned when writing facts
- [Agent registry](../observability/agent-registry.md) — agents are one category of source
