# MCP host support

**Status:** template  
**Group:** Integration · **Phase:** 5  
**[Back to map](../../MAP.md)** · **[PRD §9](../../rough-notes/iranti-core-prd.md#9-features)**

---

## What it is

Iranti connects to MCP-compatible agents such as Claude Code and Codex.

## Why it matters

MCP (Model Context Protocol) is the primary integration path for coding agents. Building MCP-first means iranti works natively with the tools developers are already using.

## How the MCP integration works

An MCP host connects to iranti at session start, registers itself with a session identifier and structured metadata, and streams the conversation as it progresses. Iranti observes the stream, manages memory writes autonomously, and surfaces injections when retrieval is warranted.

The host is responsible for:
- Registering at session start
- Streaming conversation content to iranti
- Receiving iranti's output and making it available in the agent's context
- Reporting context window state when requested

The host does not:
- Decide what to store or when
- Call write tools manually
- Filter what iranti receives from the stream

## MCP tool surface

The exact tool surface is designed before Phase 5 build begins. See [MCP tool surface](../../technical/mcp-tool-surface.md). The design principle: the agent streams context and receives injections. No manual write tools.

## Target hosts

- **Claude Code** — primary integration target, validated in Phase 5
- **Codex** — second host validation in Phase 5
- Additional MCP hosts — validated progressively

## User stories

- As a developer, I want to connect iranti to Claude Code with minimal setup so that my sessions are automatically backed by persistent memory.
- As an agent builder, I want my MCP-compatible agent to work with iranti the same way Claude Code does.

## Acceptance criteria

- [ ] The MCP server is implemented over the Attendant
- [ ] A Claude Code session can connect, stream content, and receive injections
- [ ] A second host (Codex or equivalent) connects and behaves identically to Claude Code
- [ ] End-to-end test: multi-session project scenario — facts stored in session 1 are retrieved in session 2
- [ ] End-to-end test: session interruption followed by backfill produces correct state
- [ ] A rules injection fires correctly when a preference is triggered mid-session

## Technical notes

_Fill in when ready to build (Phase 5). Cover: MCP server setup, tool definitions for the new surface, session registration protocol, stream consumption implementation, injection delivery mechanism._

## Dependencies

- Attendant complete (Phase 3)
- MCP tool surface designed (see [technical/mcp-tool-surface.md](../../technical/mcp-tool-surface.md))

## Open questions

From [§13 of the PRD](../../rough-notes/iranti-core-prd.md#13-open-items):

**Retrieval trigger in the MCP surface.** If the Attendant handles stream observation autonomously, the MCP tool surface simplifies. The exact new tool surface needs to be designed before the MCP integration is built.

## Related specs

- [Bidirectional Attendant](../intelligence/bidirectional-attendant.md) — the Attendant is what the MCP server wraps
- [MCP tool surface](../../technical/mcp-tool-surface.md) — technical design for the tool definitions
