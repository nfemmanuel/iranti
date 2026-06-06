# Human conflict resolution

**Status:** template  
**Group:** Memory lifecycle · **Phase:** 4  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

The `iranti resolve` CLI command guides a human reviewer through resolving an escalated conflict.

## Why it matters

Some conflicts genuinely require human judgment. The information available to the Librarian is not always enough to determine which of two contradictory facts is correct. A human who knows the project can make that call in seconds.

## How it works

When the Librarian cannot resolve a conflict automatically, it writes an escalation file to a designated folder. Each escalation file is a markdown document containing both conflicting facts, their provenance, and a resolution prompt.

The `iranti resolve` command reads these files and presents them interactively. The human reviewer chooses which fact is authoritative (or writes a new authoritative version). The Archivist picks up the resolved file on its next cycle and applies the resolution to the knowledge store.

## The `iranti resolve` command

```
iranti resolve              # show pending conflicts
iranti resolve <id>         # resolve a specific conflict
```

Resolution options when reviewing a conflict:
- Keep the existing fact, discard the new one
- Keep the new fact, supersede the old one
- Write a new authoritative fact that replaces both

## User stories

- As a developer, I want a simple CLI tool that surfaces the conflicts iranti could not resolve so that I can review and settle them.
- As a developer, I want the review process to show me the full context of each conflict — both facts, their sources, and when they were written — so that I can make an informed decision.

## Acceptance criteria

- [ ] `iranti resolve` lists all pending conflict escalations with a summary of each
- [ ] `iranti resolve <id>` shows the full details of one conflict: both facts, sources, confidence scores, timestamps
- [ ] The human can choose to keep either fact or write a new authoritative value
- [ ] The resolution is written to the escalation file in the format the Archivist expects
- [ ] The Archivist processes the resolved file on its next cycle and updates the knowledge store
- [ ] Resolved escalation files are moved to a resolved folder (not deleted)

## Technical notes

_Fill in when ready to build (Phase 4). Cover: escalation file format (markdown schema), resolution format the Archivist reads, CLI interaction flow, Archivist processing logic._

## Dependencies

- Archive in place (Phase 1) — pending_resolution status used for escalated facts
- Conflict detection in place (Phase 2) — escalation files created here
- Archivist in place (Phase 4)
- CLI in place (Phase 6) — `iranti resolve` is a CLI command

## Related specs

- [Conflict detection](conflict-detection.md) — creates the escalation files
- [Archive](archive.md) — escalated facts are in the archive with pending_resolution status
- [CLI](../integration/cli.md) — `iranti resolve` is part of the CLI surface
