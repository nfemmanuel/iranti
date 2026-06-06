# Conflict detection and resolution

**Status:** template  
**Group:** Memory lifecycle · **Phase:** 2  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

The Librarian detects when a new fact contradicts an existing one, and resolves it automatically when the confidence gap is sufficient — escalating to human review when it is not.

## Why it matters

The knowledge store must stay internally consistent. Conflicting facts in the store produce unreliable retrieval results and erode trust in iranti's output. Automatic resolution handles the clear-cut cases. Human review handles the genuinely ambiguous ones.

## How the Librarian decides

When a new fact arrives with the same entity address as an existing active fact:

1. **Confidence gap is large** — the newer fact has significantly higher confidence. The Librarian supersedes the old fact (moves it to archive with status `superseded`) and writes the new one as active.
2. **Confidence gap is small or unclear** — the Librarian cannot determine which fact is more reliable. It archives the existing fact with status `pending_resolution`, writes the new fact as active, and creates an escalation file for human review.
3. **Same source, newer version** — treated as an update if the source is the same. No conflict, no escalation.

Source reliability scores (see [source reliability](../intelligence/source-reliability.md)) apply a weighting to confidence at write time, which affects how the gap is calculated.

## User stories

- As a developer, I want iranti to update facts automatically when better information arrives, without surfacing conflicts I do not need to think about.
- As a developer, I want iranti to escalate genuinely ambiguous conflicts to me so that I can resolve them with the right context.
- As an operator, I want to inspect all conflict resolutions to verify that the Librarian is making good decisions.

## Acceptance criteria

- [ ] When a new fact conflicts with an existing one at the same address, the Librarian detects it
- [ ] If the confidence gap exceeds the resolution threshold, the old fact is superseded and the new one is written
- [ ] If the confidence gap is insufficient, the old fact moves to `pending_resolution` status and an escalation file is created
- [ ] All conflict events are logged in the session ledger
- [ ] The resolution threshold is configurable
- [ ] Source reliability weighting is applied before the gap is calculated

## Technical notes

_Fill in when ready to build (Phase 2). Cover: conflict detection algorithm, confidence gap threshold, escalation file format, interaction with source reliability scores._

## Dependencies

- Fact storage in place (Phase 1)
- Archive in place (Phase 1)
- Source reliability scoring (Phase 2) — confidence weighting applied before conflict assessment

## Related specs

- [Archive](archive.md) — conflicted facts move to archive
- [Human conflict resolution](human-conflict-resolution.md) — human resolution path for escalated conflicts
- [Source reliability scoring](../intelligence/source-reliability.md) — affects confidence gap calculation
- [Session ledger](../observability/session-ledger.md) — conflict events logged here
