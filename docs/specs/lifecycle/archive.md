# Archive

**Status:** template  
**Group:** Memory lifecycle · **Phase:** 1  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Facts that expire, decay, or are superseded move to a permanent archive rather than being deleted.

## Why it matters

Nothing is lost. Bad archiving decisions can be reviewed and corrected. The worst outcome of an archiving mistake is a messy archive, not lost knowledge.

## How facts reach the archive

Facts move to the archive through four paths:

1. **Expiry** — the fact's `validUntil` date has passed. The Archivist archives it on its next cycle.
2. **Decay** — the fact's confidence has fallen below the minimum threshold. The Archivist archives it on its next cycle.
3. **Superseded** — a newer, higher-confidence fact replaces it. The Librarian moves the older fact to archive with status `superseded` at write time.
4. **Pending resolution** — the Librarian detects a conflict it cannot resolve. The contested fact moves to archive with status `pending_resolution` and an escalation file is created.

The archive is a permanent record. Nothing in iranti is ever deleted.

## User stories

- As a developer, I want iranti to never permanently lose information, even when facts are replaced or expire, so that I can recover from bad archiving decisions.
- As an operator, I want to inspect archived facts to understand what was stored and when it was archived.

## Acceptance criteria

- [ ] An archive table exists in the schema, separate from the active knowledge store
- [ ] Facts can be moved to the archive with a reason (expired, decayed, superseded, pending_resolution)
- [ ] Archived facts are never deleted
- [ ] Archived facts can be queried and inspected
- [ ] The original fact id, archive timestamp, and archive reason are preserved
- [ ] No write operation deletes a fact — all writes either update or archive

## Technical notes

_Fill in when ready to build (Phase 1). Cover: archive table schema, archival function signature, distinction between archive table and active table, query interface for the archive._

## Dependencies

- Schema design complete (Phase 0) — archive table defined from the start
- Fact storage in place (Phase 1)

## Related specs

- [Fact storage](../memory-storage/fact-storage.md) — facts that move to archive
- [Memory decay](memory-decay.md) — decay triggers archival
- [Conflict detection](conflict-detection.md) — conflict escalation triggers archival with pending_resolution status
- [Schema](../../technical/schema.md) — archive table definition
