# Claude Code MCP Integration

## Overview
This feature exposes Iranti to Claude Code through the installed CLI surface: `iranti mcp` for the stdio MCP server and `iranti claude-hook` for automatic working-memory injection. Both commands can recover runtime configuration from a project-local `.env.iranti` plus the linked instance env.

## Inputs
| Input | Type | Description |
|---|---|---|
| `DATABASE_URL` | string | PostgreSQL connection string used by the local Iranti SDK. |
| `LLM_PROVIDER` | string? | Optional provider override for Iranti reasoning tasks. |
| `IRANTI_INSTANCE_ENV` | string? | Path to the instance env file, usually loaded from `.env.iranti`. |
| `IRANTI_PROJECT_ENV` | string? | Optional explicit `.env.iranti` path. |
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
1. Start the stdio MCP server through `iranti mcp`.
2. Load runtime configuration from:
   - explicit env variables, if present
   - fallback `.env`
   - linked instance env from `.env.iranti`
   - `.env.iranti` itself for project binding values
3. Require a valid `DATABASE_URL` after env resolution.
4. Auto-register a default Claude-facing agent if needed.
5. Expose Iranti memory and write operations as MCP tools.
6. For hook usage, parse Claude Code hook stdin payload.
7. On `SessionStart`, call `handshake()` and emit a compact working-memory brief.
8. On `UserPromptSubmit`, call `attend()` and emit only relevant retrieved facts when injection is needed.
9. Keep durable writes explicit through MCP tool calls rather than auto-saving all turns.

## Edge Cases
- Missing `DATABASE_URL`: process exits with a fatal configuration error.
- Missing `.env.iranti` in an installed-package project means the hook and MCP server must rely on direct environment configuration.
- Empty `UserPromptSubmit` prompt: hook emits no additional context.
- Invalid `valueJson` or `propertiesJson`: MCP write/relate tools reject with a clear JSON parsing error.
- Unregistered agent ids: auto-registration creates a stable Claude-facing agent profile.
- Hook events other than `SessionStart` and `UserPromptSubmit`: helper rejects with an explicit error.
- Protected Staff Namespace entries remain hidden from external agent query surfaces by design.

## Test Results
- TypeScript build passes with the MCP and hook scripts included.
- `iranti mcp --help` works through the installed CLI handoff path.
- `iranti claude-hook --help` works through the installed CLI handoff path.
- Installed-package Claude Code integration no longer requires hardcoded `DATABASE_URL` in hook commands when `.env.iranti` points to a valid instance env.

## Related
- `scripts/iranti-mcp.ts`
- `scripts/claude-code-memory-hook.ts`
- `src/lib/runtimeEnv.ts`
- `docs/guides/claude-code.md`
- `src/sdk/index.ts`
