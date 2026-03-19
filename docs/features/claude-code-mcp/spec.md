# Claude Code MCP Integration

## Overview
This feature exposes Iranti to Claude Code through the installed CLI surface: `iranti claude-setup` for project-local scaffolding, `iranti mcp` for the stdio MCP server, and `iranti claude-hook` for automatic working-memory injection. All three commands can recover runtime configuration from a project-local `.env.iranti` plus the linked instance env.

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
| `--force` | boolean | Overwrite existing Claude scaffold files when running `iranti claude-setup`. |
| `--scan` | string | Optional parent directory for batch Claude scaffold discovery. |
| `--recursive` | boolean | Recursively scan nested project trees when used with `--scan`. |
| Claude Code hook stdin JSON | object | Claude Code event payload for `SessionStart` and `UserPromptSubmit`. |

## Outputs
| Output | Type | Description |
|---|---|---|
| MCP tools | stdio MCP server | Exposes `iranti_handshake`, `iranti_attend`, `iranti_observe`, `iranti_query`, `iranti_search`, `iranti_write`, `iranti_ingest`, `iranti_relate`, and `iranti_who_knows`. |
| Hook context | JSON | Emits `hookSpecificOutput.additionalContext` for Claude Code hook events. |
| Structured tool results | JSON | Returns tool output as both plain text and `structuredContent` for MCP clients. |
| Claude scaffold files | filesystem | Writes `.mcp.json` and `.claude/settings.local.json` in the target project. |
| Batch scan summary | text | Reports how many discovered projects had MCP/settings created, updated, or left unchanged. |

## Decision Tree / Flow
1. Run `iranti claude-setup` from a bound project, or create the same files manually.
2. Optional batch mode: `iranti claude-setup --scan <dir>` inspects immediate subdirectories that already contain `.claude/`.
3. Optional recursive batch mode: add `--recursive` to walk nested project trees while skipping `node_modules`, `.git`, build output, and other obvious non-project directories.
4. Write or merge `.mcp.json` so it contains an `iranti` MCP server entry.
5. Write `.claude/settings.local.json` pointing hooks at `iranti claude-hook` when the file is missing, or overwrite it only when `--force` is supplied.
6. Start the stdio MCP server through `iranti mcp`.
7. Load runtime configuration from:
   - explicit env variables, if present
   - fallback `.env`
   - linked instance env from `.env.iranti`
   - `.env.iranti` itself for project binding values
8. Require a valid `DATABASE_URL` after env resolution.
9. Auto-register a default Claude-facing agent if needed.
10. Expose Iranti memory and write operations as MCP tools.
11. For hook usage, parse Claude Code hook stdin payload.
12. On `SessionStart`, call `handshake()` and emit a compact working-memory brief.
13. On `UserPromptSubmit`, call `attend()` and emit only relevant retrieved facts when injection is needed.
14. Keep durable writes explicit through MCP tool calls rather than auto-saving all turns.

## Edge Cases
- Missing `DATABASE_URL`: process exits with a fatal configuration error.
- Missing `.env.iranti` in an installed-package project means the hook and MCP server must rely on direct environment configuration.
- Empty `UserPromptSubmit` prompt: hook emits no additional context.
- Invalid `valueJson` or `propertiesJson`: MCP write/relate tools reject with a clear JSON parsing error.
- Unregistered agent ids: auto-registration creates a stable Claude-facing agent profile.
- Existing `.mcp.json` / `.claude/settings.local.json`: `iranti claude-setup` leaves them untouched unless `--force` is supplied.
- Existing `.mcp.json` with other MCP servers: the `iranti` server is merged in without removing the others.
- `--scan` mode does not create `.env.iranti`; it only broadens Claude scaffolding for already-Claude-enabled projects.
- `--recursive` skips obvious non-project directories such as `.git`, `node_modules`, and build output folders to keep scan time reasonable.
- Hook events other than `SessionStart` and `UserPromptSubmit`: helper rejects with an explicit error.
- Protected Staff Namespace entries remain hidden from external agent query surfaces by design.

## Test Results
- TypeScript build passes with the MCP and hook scripts included.
- `iranti claude-setup --help` works through the installed CLI surface.
- `iranti claude-setup --scan <dir>` reports created/updated/unchanged status per discovered project.
- `iranti claude-setup --scan <dir> --recursive` finds nested Claude-enabled projects.
- `iranti mcp --help` works through the installed CLI handoff path.
- `npm run test:mcp-smoke` starts the stdio MCP server, lists tools, and successfully calls `iranti_handshake`, `iranti_write`, `iranti_query`, `iranti_search`, and `iranti_attend`.
- `iranti claude-hook --help` works through the installed CLI handoff path.
- Installed-package Claude Code integration no longer requires hardcoded `DATABASE_URL` in hook commands when `.env.iranti` points to a valid instance env.

## Related
- `scripts/iranti-mcp.ts`
- `scripts/claude-code-memory-hook.ts`
- `src/lib/runtimeEnv.ts`
- `docs/guides/claude-code.md`
- `src/sdk/index.ts`
