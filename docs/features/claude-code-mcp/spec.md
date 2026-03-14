# Claude Code MCP Integration

## Overview
This feature exposes Iranti to Claude Code through a local stdio MCP server and an optional hook helper. The MCP server gives Claude explicit tools for identity lookup, hybrid search, and durable writes. The hook helper automatically injects working memory at Claude Code `SessionStart` and `UserPromptSubmit`.

## Inputs
| Input | Type | Description |
|---|---|---|
| `DATABASE_URL` | string | PostgreSQL connection string used by the local Iranti SDK. |
| `LLM_PROVIDER` | string? | Optional provider override for Iranti reasoning tasks. |
| `IRANTI_MCP_DEFAULT_AGENT` | string? | Default agent id for MCP tool calls. |
| `IRANTI_MCP_DEFAULT_SOURCE` | string? | Default source label for MCP writes and ingests. |
| `IRANTI_CLAUDE_AGENT_ID` | string? | Default agent id used by the Claude Code hook helper. |
| Claude Code hook stdin JSON | object | Claude Code event payload for `SessionStart` and `UserPromptSubmit`. |

## Outputs
| Output | Type | Description |
|---|---|---|
| MCP tools | stdio MCP server | Exposes `iranti_handshake`, `iranti_attend`, `iranti_observe`, `iranti_query`, `iranti_search`, `iranti_write`, `iranti_ingest`, `iranti_relate`, and `iranti_who_knows`. |
| Hook context | JSON | Emits `hookSpecificOutput.additionalContext` for Claude Code hook events. |
| Structured tool results | JSON | Returns tool output as both plain text and `structuredContent` for MCP clients. |

## Decision Tree / Flow
1. Start the stdio MCP server with a valid `DATABASE_URL`.
2. Auto-register a default Claude-facing agent if needed.
3. Expose Iranti memory and write operations as MCP tools.
4. For hook usage, parse Claude Code hook stdin payload.
5. On `SessionStart`, call `handshake()` and emit a compact working-memory brief.
6. On `UserPromptSubmit`, call `attend()` and emit only relevant retrieved facts when injection is needed.
7. Keep durable writes explicit through MCP tool calls rather than auto-saving all turns.

## Edge Cases
- Missing `DATABASE_URL`: process exits with a fatal configuration error.
- Empty `UserPromptSubmit` prompt: hook emits no additional context.
- Invalid `valueJson` or `propertiesJson`: MCP write/relate tools reject with a clear JSON parsing error.
- Unregistered agent ids: auto-registration creates a stable Claude-facing agent profile.
- Hook events other than `SessionStart` and `UserPromptSubmit`: helper rejects with an explicit error.

## Test Results
- TypeScript build passes with the new MCP and hook scripts included.
- `node dist/scripts/iranti-mcp.js --help` prints usage successfully after build.
- `node dist/scripts/claude-code-memory-hook.js --help` prints usage successfully after build.

## Related
- `scripts/iranti-mcp.ts`
- `scripts/claude-code-memory-hook.ts`
- `docs/guides/claude-code.md`
- `src/sdk/index.ts`
