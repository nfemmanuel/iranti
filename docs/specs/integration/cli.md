# CLI

**Status:** template  
**Group:** Integration · **Phase:** 6  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Command-line interface for querying memory, managing facts, running diagnostics, and configuration.

## Why it matters

Developers need direct access to iranti without going through an agent. The CLI is the operational tool — for inspecting what is stored, verifying that iranti is working, resolving conflicts, and managing the system.

## Command surface

The minimum viable CLI supports:

```
iranti bind <project>       # bind iranti to a project
iranti unbind               # unbind from current project
iranti query <question>     # query memory in natural language
iranti facts <entity>       # list facts for an entity
iranti inspect <fact-id>    # inspect a specific fact in detail
iranti archive <fact-id>    # manually archive a fact
iranti resolve              # list and resolve pending conflicts
iranti resolve <id>         # resolve a specific conflict
iranti status               # show iranti operational status
iranti run-archivist        # manually trigger an Archivist cycle
iranti keys                 # manage API keys
iranti config               # view and edit configuration
```

## User stories

- As a developer, I want to inspect what iranti has stored about my project so that I can verify it is capturing the right information.
- As a developer, I want to run a diagnostics check to confirm iranti is working before starting a session.
- As a developer, I want to resolve conflict escalations from the command line without leaving my terminal.
- As an operator, I want to manually trigger an Archivist cycle when testing maintenance behaviour.

## Acceptance criteria

- [ ] `iranti bind` binds iranti to a project and registers the project entity
- [ ] `iranti query` retrieves and displays relevant memory for a natural language question
- [ ] `iranti facts <entity>` lists all active facts for an entity in a readable format
- [ ] `iranti resolve` lists pending conflicts and guides interactive resolution
- [ ] `iranti status` shows: version, connected project, knowledge store size, pending conflicts count, last Archivist cycle
- [ ] `iranti run-archivist` triggers a full maintenance cycle
- [ ] The CLI can be installed globally and works without an active agent session

## Technical notes

_Fill in when ready to build (Phase 6). Cover: CLI framework choice, output formatting, interactive prompt design for `iranti resolve`, global install mechanism._

## Dependencies

- Library complete (Phase 1)
- Archivist complete (Phase 4)
- Human conflict resolution complete (Phase 4)

## Related specs

- [Human conflict resolution](../lifecycle/human-conflict-resolution.md) — `iranti resolve` is part of the CLI
- [SDK](sdk.md) — CLI and SDK share the same underlying API surface
