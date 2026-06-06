# MCP tool surface

**Status:** template  
**Needed by:** Phase 5  
**[Back to map](../MAP.md)**

---

> This design must be complete before Phase 5 (MCP integration) build begins. The new tool surface should be simpler than the current iranti — the agent streams context and receives injections, without manually calling write tools.

## Purpose

Design the MCP tool surface for iranti-core. The surface is what MCP-compatible agents (Claude Code, Codex, etc.) call to interact with iranti. The design goal: minimal, clean, and autonomous. The agent should not be responsible for memory decisions.

## Design principles

- **Minimal.** Fewer tools than the current iranti. The agent does not call write tools.
- **Autonomous.** The Attendant handles write routing. The agent streams, iranti decides.
- **Consistent.** All MCP hosts call the same tools in the same way.
- **Predictable.** Tool contracts are stable. Breaking changes require versioning.

## Proposed tool surface (draft)

### `iranti_handshake`
Called at session start. Registers the host, loads operating rules, returns the initial working memory brief.

**Input:**
- `host`: host identifier (claude_code, codex, ...)
- `sessionId`: unique session identifier
- `project`: project identifier
- `agentId`: (optional) agent identifier for continuity across sessions

**Output:**
- Operating rules for this session
- Initial context brief (relevant memory for the current project)
- Session confirmation

### `iranti_attend`
Called each turn. Provides the current turn context to the Attendant and receives injections if any are warranted.

**Input:**
- `phase`: pre-response or post-response
- `content`: the turn content (user message + agent response, tool outputs, etc.)
- `windowState`: (optional) report of what is currently in the context window

**Output:**
- `injections`: facts to inject, with tier (primary/secondary)
- `corrections`: stale context corrections
- `rules`: any rule injections triggered this turn
- `inject`: boolean — whether any injection is warranted

### `iranti_checkpoint` (optional)
Write a checkpoint at the end of a task or session.

**Input:**
- `summary`: task state summary
- `taskName`: (optional) label for this checkpoint

**Output:**
- `checkpointId`: confirmation

## What is not in the surface

The following are not MCP tools in the rebuild:
- Write tools — the Attendant handles writes autonomously via `iranti_attend`
- Query tools — retrieval is surfaced through `iranti_attend` injections
- Conflict tools — conflicts are handled via the CLI `iranti resolve`

## Current iranti tool surface (for comparison)

_Read the current AGENTS.md and list the existing tools here for comparison. Identify what is being removed and why._

## Open questions

From [§13 of the PRD](../rough-notes/iranti-core-prd.md#13-open-items):

**Retrieval trigger in the MCP surface.** If the Attendant handles stream observation autonomously, the MCP tool surface simplifies. The exact new tool surface needs to be designed before Phase 5 begins.

**What exactly counts as the stream.** Does `content` in `iranti_attend` include tool call outputs? File contents the agent read? Only messages and responses? This needs a precise answer before the Phase 5 build.

## Related specs

- [MCP host support](../specs/integration/mcp-host-support.md) — feature spec for MCP integration
- [Bidirectional Attendant](../specs/intelligence/bidirectional-attendant.md) — what the MCP surface wraps
- [Context window observation](../specs/retrieval/context-window-observation.md) — `windowState` feeds this
