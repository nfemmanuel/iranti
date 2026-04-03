# Claude Code MCP Integration

## Overview
This feature exposes Iranti to Claude Code through the installed CLI surface: `iranti claude-setup` for project-local scaffolding, `iranti mcp` for the stdio MCP server, and `iranti claude-hook` for automatic working-memory injection. All three commands can recover runtime configuration from a project-local `.env.iranti` plus the linked instance env.

This spec is intentionally host-specific. The shared memory contract lives in `docs/features/memory-lifecycle/spec.md`; this file defines only the Claude Code transport, hook, and scaffold behavior that makes Claude comply with that core contract.

## Inputs
| Input | Type | Description |
|---|---|---|
| `DATABASE_URL` | string | PostgreSQL connection string used by the local Iranti SDK. |
| `LLM_PROVIDER` | string? | Optional provider override for Iranti reasoning tasks. |
| `IRANTI_INSTANCE_ENV` | string? | Path to the instance env file, usually loaded from `.env.iranti`. |
| `IRANTI_PROJECT_ENV` | string? | Optional explicit `.env.iranti` path. |
| `IRANTI_MCP_DEFAULT_AGENT` | string? | Default agent id for MCP tool calls. |
| `IRANTI_MCP_DEFAULT_SOURCE` | string? | Default source label for MCP writes and ingests. |
| `IRANTI_MCP_HOST` | string? | Optional host label for first-party session-ledger metadata. Defaults to `generic_mcp` for direct MCP launches. |
| `IRANTI_CLAUDE_AGENT_ID` | string? | Default agent id used by the Claude Code hook helper. |
| `IRANTI_AUTO_REMEMBER` | boolean? | Opt-in explicit prompt auto-save into `IRANTI_MEMORY_ENTITY` before retrieval. |
| `IRANTI_PERSONAL_MEMORY_ENTITY` | string? | Optional personal-memory target for auto-remembered user facts. Defaults to `user/main`. |
| `--force` | boolean | Overwrite existing Claude scaffold files when running `iranti claude-setup`. |
| `--scan` | string | Optional parent directory for batch Claude scaffold discovery. |
| `--recursive` | boolean | Recursively scan nested project trees when used with `--scan`. |
| Claude Code hook stdin JSON | object | Claude Code event payload for `SessionStart`, `UserPromptSubmit`, and `Stop`. |

## Outputs
| Output | Type | Description |
|---|---|---|
| MCP tools | stdio MCP server | Exposes `iranti_handshake`, `iranti_attend`, `iranti_observe`, `iranti_checkpoint`, `iranti_query`, `iranti_history`, `iranti_search`, `iranti_write`, `iranti_write_issue`, `iranti_remember_response`, `iranti_ingest`, `iranti_relate`, `iranti_related`, `iranti_related_deep`, and `iranti_who_knows`. |
| Hook context | JSON | Emits `hookSpecificOutput.additionalContext` for Claude Code hook events. |
| Structured tool results | JSON | Returns tool output as both plain text and `structuredContent` for MCP clients. |
| Claude scaffold files | filesystem | Writes `.mcp.json`, `.vscode/mcp.json`, and `.claude/settings.local.json` in the target project. |
| Batch scan summary | text | Reports how many discovered projects had MCP/settings created, updated, or left unchanged. |

## Decision Tree / Flow
1. Run `iranti claude-setup` from a bound project, or create the same files manually.
2. Optional batch mode: `iranti claude-setup --scan <dir>` inspects immediate subdirectories that already contain `.claude/`.
3. Optional recursive batch mode: add `--recursive` to walk nested project trees while skipping `node_modules`, `.git`, build output, and other obvious non-project directories.
4. Write or merge `.mcp.json` so it contains an `iranti` MCP server entry.
5. Write or merge `.vscode/mcp.json` so VS Code-native MCP clients expose the same `iranti` server from the workspace.
6. When a project binding is known, pin `IRANTI_PROJECT_ENV` in `.mcp.json` and use `${workspaceFolder}/.env.iranti` in `.vscode/mcp.json` when the binding lives in the project root.
7. Write `.claude/settings.local.json` using Claude Code's `matcher` + `hooks` schema, pointing hooks at `iranti claude-hook` when the file is missing.
8. If an existing settings file contains the older Iranti-generated `command` + `args` hook shape, upgrade it in place to the current Claude Code schema.
9. Start the stdio MCP server through `iranti mcp`.
10. If an operator launches `iranti mcp` directly in a terminal, the process intentionally stays running because it is waiting for an MCP client over stdio.
11. Load runtime configuration from:
   - explicit env variables, if present
   - fallback `.env`
   - linked instance env from `.env.iranti`
   - `.env.iranti` itself for project binding values
12. Require a valid `DATABASE_URL` after env resolution.
13. Auto-register a default Claude-facing agent if needed.
14. Expose Iranti memory and write operations as MCP tools.
15. For hook usage, parse Claude Code hook stdin payload.
16. On `SessionStart`, call `handshake()` and emit a compact working-memory brief.
17. Handshake returns the Attendant operating-rules summary plus a stricter read/write discipline for Iranti usage, including when to query, search, write, remember durable summaries, and avoid saving ephemeral chatter.
18. The operating rules explicitly position Iranti as the default shared working-memory layer for anything another session, another agent, or a later handoff may need, even if the client also keeps private notes elsewhere.
19. The operating rules explicitly tell agents to persist durable file-state changes that matter later, including file creation, moves, renames, deletions, repurposing, and notable artifacts or paths produced during the task.
20. When `IRANTI_MEMORY_ENTITY` contains explicit project-scoped policy facts such as `agent_operating_rules`, `agent_preferences`, or `*_rule`, handshake may also return a bounded `projectPolicies` appendix and append those rules as `PROJECT POLICY (...)` guidance in the effective operating rules.
21. On `UserPromptSubmit`, if `IRANTI_AUTO_REMEMBER=true`, extract only narrow explicit prompt facts and write personal facts to `IRANTI_PERSONAL_MEMORY_ENTITY`/`user/main` while project facts still go to `IRANTI_MEMORY_ENTITY`.
22. Prompt-captured personal facts are stored as direct user memory so later explicit user corrections can replace older hook-written values.
23. On `UserPromptSubmit`, call `attend()` and emit only relevant retrieved facts when injection is needed.
24. If no handshake has been performed yet for that agent in the current process, `attend()` auto-runs a bootstrap handshake before making the injection decision.
25. The MCP `iranti_attend` tool accepts `message` as a host-compatibility alias for `latestMessage` when a client cannot rename that field cleanly.
26. If Claude explicitly calls `iranti_write` for a personal-memory key such as `favorite_book`, the MCP server reroutes that write to the configured canonical personal entity instead of allowing project-local identity forks like `user/nf` vs `user/main`.
27. Recall-class prompts such as `what is my favorite ...`, `what is the next step`, `what did we decide`, and `what is the blocker` are treated as mandatory memory prompts and bypass the LLM memory-needed classifier.
28. On `Stop`, if `IRANTI_AUTO_REMEMBER=true`, extract only narrow assistant-response summary patterns from `last_assistant_message` and write project-scoped summaries to `IRANTI_MEMORY_ENTITY`.
29. If the strict assistant summary contains checkpoint-worthy project progress such as `current_step`, `next_step`, `open_risks`, or important artifacts, the `Stop` hook should also emit a shared checkpoint to `IRANTI_MEMORY_ENTITY` so other sessions can resume work without waiting for an explicit MCP checkpoint call.
30. Narrow project durability now includes strict patterns for:
   - `current_step`
   - `next_step`
   - `blocker`
   - `decision`
   - `current_owner`
   - `open_risks`
   - `important_artifacts`
   - `recent_file_changes`
   - `failed_paths`
   - `alternative_routes`
31. MCP clients may call `iranti_checkpoint` explicitly during active work to persist current step, next step, open risks, recent outputs, and shared entity state without waiting for a final answer.
32. MCP clients may call `iranti_remember_response` explicitly to persist a strict assistant summary such as `The next step is ...` without relying on the Claude `Stop` hook path.
33. MCP tool descriptions explicitly tell Claude-facing clients to consult Iranti for recall questions about remembered preferences, decisions, blockers, next steps, and prior project facts before guessing or saying they do not know.
34. Handshake may also return a backfill suggestion when recent messages appear to contain durable facts that have not yet been persisted.
35. Keep durable writes explicit through MCP tool calls rather than auto-saving all turns; the hook never bulk-saves Claude responses.

## Edge Cases
- Missing `DATABASE_URL`: process exits with a fatal configuration error.
- Direct terminal launch of `iranti mcp`: the process intentionally stays running because it is waiting for a stdio MCP client; this is not a crash or deadlock.
- Missing `.env.iranti` in an installed-package project means the hook and MCP server must rely on direct environment configuration.
- Empty `UserPromptSubmit` prompt: hook emits no additional context.
- Empty `Stop` message: hook exits without writing.
- `IRANTI_AUTO_REMEMBER=true` without `IRANTI_MEMORY_ENTITY`: project-scoped auto-write is skipped rather than guessing a target entity; personal facts still default to `user/main`.
- Auto-remember extracts only strict prompt patterns; arbitrary narrative text is ignored.
- Assistant-response auto-remember extracts only strict summary patterns such as `the next step is ...`, `the current step is ...`, `open risks are ...`, `important artifacts are ...`, `file created ...`, `we decided ...`, or `your favorite ... is ...`.
- `iranti_remember_response` also ignores arbitrary prose and persists only strict assistant-summary patterns.
- Invalid `valueJson` or `propertiesJson`: MCP write/relate tools reject with a clear JSON parsing error.
- Unregistered agent ids: auto-registration creates a stable Claude-facing agent profile.
- Existing `.mcp.json`: the `iranti` server is merged in without removing other MCP servers, and pinned to the project binding when one is available.
- Existing `.vscode/mcp.json`: the `iranti` server is merged in without removing other MCP servers.
- Existing `.claude/settings.local.json`: `iranti claude-setup` upgrades legacy Iranti hook entries to Claude Code's current `matcher` + `hooks` schema, and otherwise leaves the file untouched unless `--force` is supplied.
- `--scan` mode does not create `.env.iranti`; it only broadens Claude scaffolding for already-Claude-enabled projects.
- `--recursive` skips obvious non-project directories such as `.git`, `node_modules`, and build output folders to keep scan time reasonable.
- Hook events other than `SessionStart`, `UserPromptSubmit`, and `Stop`: helper rejects with an explicit error.
- Protected Staff Namespace entries remain hidden from external agent query surfaces by design.

## Test Results
- TypeScript build passes with the MCP and hook scripts included.
- `iranti claude-setup --help` works through the installed CLI surface.
- `iranti claude-setup --scan <dir>` reports created/updated/unchanged status per discovered project.
- `iranti claude-setup --scan <dir> --recursive` finds nested Claude-enabled projects.
- `iranti claude-setup` writes both `.mcp.json` and `.vscode/mcp.json` when a bound project is available.
- `iranti mcp --help` works through the installed CLI handoff path.
- `npm run test:mcp-smoke` starts the stdio MCP server, lists tools, and successfully calls `iranti_handshake`, `iranti_checkpoint`, `iranti_write`, `iranti_write_issue`, `iranti_query`, `iranti_history`, `iranti_search`, `iranti_attend`, `iranti_remember_response`, `iranti_relate`, `iranti_related`, `iranti_related_deep`, and verifies the graceful-shutdown and stdin-close lifecycle.
- `npm run test:mcp-smoke` also verifies handshake surfaces bounded `projectPolicies` when `IRANTI_MEMORY_ENTITY` contains explicit project-scoped policy facts.
- `npm run test:mcp-attend-shutdown-regressions` verifies `iranti_attend` message alias and shutdown checkpoint preservation as focused regressions separate from the broader smoke.
- `iranti claude-hook --help` works through the installed CLI handoff path.
- Installed-package Claude Code integration no longer requires hardcoded `DATABASE_URL` in hook commands when `.env.iranti` points to a valid instance env.
- `npm run test:claude-hook` verifies project prompt durability for `current_step` and `open_risks` in addition to the existing favorite and `next_step` paths.

## Related
- `scripts/iranti-mcp.ts`
- `scripts/claude-code-memory-hook.ts`
- `src/lib/runtimeEnv.ts`
- `docs/guides/claude-code.md`
- `src/sdk/index.ts`
