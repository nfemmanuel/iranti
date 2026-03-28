# CLI Attendant Debug Commands

## Overview
This feature adds two operator-facing CLI commands, `iranti handshake` and `iranti attend`, for inspecting Attendant behavior outside Claude Code, Codex, or API calls. They are intended for debugging and manual verification of memory briefs and injection decisions, not as a replacement for the normal MCP + hook integration flow.

## Inputs
| Input | Type | Description |
|---|---|---|
| `--instance` | `string` | Optional instance name whose env should be loaded directly. |
| `--project-env` | `string` | Optional explicit `.env.iranti` path. |
| `--agent` | `string` | Optional agent id override. Falls back to bound project agent or `iranti_cli`. |
| `--task` | `string` | Optional task string for `iranti handshake`. |
| `--recent` | `string` | Optional `||`-delimited recent messages for `iranti handshake`. |
| `--recent-file` | `string` | Optional newline-delimited recent-messages file for `iranti handshake`. |
| `--backfill` | `string` | Optional chat-transcript file to import for durable fact backfill before running `iranti handshake`. |
| `message` / `--message` | `string` | Latest user message for `iranti attend`. |
| `--context` | `string` | Inline current-context string for `iranti attend`. |
| `--context-file` | `string` | File containing current context for `iranti attend`. |
| `--entity-hint` | `string` | Optional deterministic `entityType/entityId` hint for `iranti attend`. |
| `--force` | `boolean` | Forces injection in `iranti attend`. |
| `--max-facts` | `number` | Optional max facts limit for `iranti attend`. |
| `--json` | `boolean` | Emits machine-readable JSON output instead of the text summary. |

## Outputs
| Output | Type | Description |
|---|---|---|
| Handshake summary | text | Agent, env source, inferred task, the full operating-rules block, working-memory count, loaded facts, and optional backfill suggestion/import summary. |
| Attend summary | text | Agent, env source, injection decision, reasoning, and selected facts. |
| JSON payload | object | Full handshake brief or attend decision/result plus command metadata. |

## Decision Tree / Flow
1. Resolve runtime configuration from `--instance`, explicit `--project-env`, or the current project binding.
2. Require a real `DATABASE_URL` after env resolution.
3. Resolve the agent id from `--agent`, bound project env, or the fallback `iranti_cli`.
4. Construct a local `Iranti` SDK instance against the resolved database.
5. For `iranti handshake`, call `iranti.handshake()` with the requested task and recent messages.
6. If `--backfill <chat-file>` is supplied, parse the transcript, import only narrow durable-fact patterns, and then run handshake using the transcript messages as recent context when no explicit `--recent*` input was provided.
7. Print the full multi-line operating-rules block so operators can inspect the active Attendant discipline instead of a truncated summary.
8. The printed rules explicitly position Iranti as the default shared working-memory layer for durable task state, handoffs, decisions, file-state changes, and validated environment details.
9. The printed rules explicitly tell agents to record durable file-state changes that will matter later, including file creation, moves, renames, deletions, repurposing, and notable artifacts or paths.
10. Surface a backfill suggestion when recent messages appear to contain durable facts that are not yet persisted.
11. For `iranti attend`, call `iranti.attend()` with the latest message, current context, optional entity hint, and optional force/max-facts settings.
12. If no brief exists yet for the agent in the current process, `iranti attend` auto-runs a bootstrap handshake first and reports that in the result.
13. Render either a concise text summary or JSON.
14. Remind the operator that these commands are inspection tools, not the primary Claude Code integration path.

## Edge Cases
- Missing `DATABASE_URL`: command fails with guidance to use a bound project or `--instance`.
- `--backfill` transcript with no durable fact patterns: handshake still runs normally after importing nothing.
- Missing attend message: command fails with usage guidance.
- Invalid `--entity-hint`: command fails unless it uses `entityType/entityId` format.
- Invalid `--max-facts`: command fails unless it is a positive integer.
- No working memory loaded: handshake prints an explicit empty-state message.
- No facts selected for injection: attend prints an explicit empty-state message.

## Test Results
- `npx tsc --noEmit` passes with the new CLI commands wired into dispatch and help output.
- `npx ts-node tests/attendant/run_backfill_tests.ts` verifies transcript parsing and durable-fact import for `--backfill`.
- `iranti attend --instance local --agent claude_code_main --message "What did we decide earlier?" --context "USER: We talked about snack_plan for game_night_app. ASSISTANT: Noted." --json` returns a structured attend decision successfully.
- `iranti handshake` is wired into the same runtime-env resolution path and compiles cleanly; on the current local instance its full handshake path exceeded the local validation timeout and should be treated as a follow-up runtime check rather than a claimed benchmark pass.

## Related
- `scripts/iranti-cli.ts`
- `src/sdk/index.ts`
- `src/attendant/AttendantInstance.ts`
- `docs/guides/claude-code.md`
