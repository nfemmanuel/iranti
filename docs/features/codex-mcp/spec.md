# Codex MCP Integration

## Overview

This feature connects Codex to Iranti through Codex's MCP client using the installed Iranti CLI surface. It provides a repeatable setup path for registering `iranti mcp` globally in Codex through either `iranti codex-setup` or `iranti integrate codex`, while keeping project-specific runtime resolution in `.env.iranti` and the linked instance env. The default global registration is intentionally unpinned so one global Codex MCP entry can be reused across multiple bound repos, but the setup flow now also writes or merges project-local `.mcp.json` and `.vscode/mcp.json` files pinned to the active project binding when one is available. Because Codex does not have the Claude `Stop` hook path, the MCP surface also exposes an explicit `iranti_remember_response` tool for strict assistant-summary persistence.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--name` | string | MCP server name to register in Codex. Defaults to `iranti`. |
| `--agent` | string | Default Iranti agent id for Codex sessions. Defaults to `codex_code`. |
| `--source` | string | Default provenance label used for writes through MCP. Defaults to `Codex`. |
| `--provider` | string | Optional `LLM_PROVIDER` override passed to the MCP process. |
| `--project-env` | string | Optional explicit `.env.iranti` path to pin the global Codex MCP server to one project. |
| `--no-workspace-file` | boolean | Skip writing or merging project-local MCP files. |
| `.env.iranti` | file | Project binding file containing `IRANTI_URL`, `IRANTI_API_KEY`, `IRANTI_AGENT_ID`, and `IRANTI_INSTANCE_ENV`. |
| `IRANTI_AUTO_REMEMBER` | boolean? | Opt-in explicit prompt auto-save into `IRANTI_MEMORY_ENTITY` before `iranti_attend` retrieval. |
| `IRANTI_PERSONAL_MEMORY_ENTITY` | string? | Optional personal-memory target for auto-remembered user facts. Defaults to `user/main`. |
| `iranti_remember_response` | MCP tool | Explicit strict assistant-summary persistence for Codex and other MCP clients without a `Stop` hook; may optionally pin `projectEntity` or `personalEntity`. |
| linked instance env | file | Instance environment file referenced by `IRANTI_INSTANCE_ENV`, containing `DATABASE_URL`, `LLM_PROVIDER`, and provider keys. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Codex MCP registration | global config entry | A registered MCP server in Codex pointing at `iranti mcp` by default. |
| project `.mcp.json` | filesystem | A merged MCP server entry pinned to the local `.env.iranti` when setup can resolve a project binding. |
| project `.vscode/mcp.json` | filesystem | A VS Code-native MCP server entry for workspace sessions, usually using `envFile=${workspaceFolder}/.env.iranti`. |
| `codex mcp get iranti` | CLI output | Verification of the stored Codex MCP configuration. |
| `codex -C <project>` | CLI command | Launches Codex in a bound project so `.env.iranti` is in scope for `iranti mcp`. |

## Decision Tree / Flow

1. Install Iranti globally and create a project binding with `iranti project init`.
2. Run `iranti codex-setup` or `iranti integrate codex`.
3. The setup script verifies `codex` is installed.
4. On Windows, Codex resolution prefers a concrete CLI target such as `codex.exe`, otherwise falls back to the npm-installed Codex package entrypoint behind the shim.
5. If a Codex MCP entry with the target name already exists, remove it.
6. Register a new global Codex MCP entry using `codex mcp add`.
7. If `--project-env` is provided, validate and store it as `IRANTI_PROJECT_ENV`. Otherwise leave the registration unpinned.
8. By default register `iranti mcp`; only use `--local-script` for repo-bound development.
9. Unless `--no-workspace-file` is supplied, locate the active project binding from `--project-env` or the nearest ancestor `.env.iranti` and write or merge project-local `.mcp.json` and `.vscode/mcp.json` files.
10. The project-local `.mcp.json` pins `IRANTI_PROJECT_ENV` and carries the default Codex agent/source for repo-local MCP consumers.
11. The project-local `.vscode/mcp.json` exposes the same `iranti` server through VS Code's native workspace MCP surface so Codex VS Code sessions do not depend on cross-app discovery.
12. Store only safe defaults and any explicitly requested pinned `IRANTI_PROJECT_ENV` in the global MCP entry.
13. At runtime, `iranti mcp` loads `IRANTI_PROJECT_ENV` first when explicitly pinned and otherwise falls back to the active project/workspace.
14. If an operator launches `iranti mcp` directly in a terminal, the process intentionally stays running because it is waiting for an MCP client over stdio.
15. The intended host pattern is: `iranti_handshake` at session start, then `iranti_attend` before every reply generation.
16. If the host does not support a true session-start hook, call `iranti_handshake` on the first user turn before recall-sensitive work begins.
17. Handshake returns the Attendant operating-rules summary plus a stricter read/write discipline for Iranti usage, including when to query, search, write, remember durable summaries, and avoid saving ephemeral chatter.
18. The operating rules explicitly position Iranti as the default shared working-memory layer for anything another session, another agent, or a later handoff may need, even if Codex also keeps private notes elsewhere.
19. The operating rules explicitly tell agents to persist durable file-state changes that matter later, including file creation, moves, renames, deletions, repurposing, and notable artifacts or paths produced during the task.
20. If `IRANTI_AUTO_REMEMBER=true`, `iranti_attend` first persists only narrow explicit prompt facts, routing personal facts to `IRANTI_PERSONAL_MEMORY_ENTITY`/`user/main` and project facts to `IRANTI_MEMORY_ENTITY`.
21. Prompt-captured personal facts are stored as direct user memory so later explicit user corrections can replace older hook-written values.
22. If no handshake has been performed yet for that agent in the current process, `iranti_attend` auto-runs a bootstrap handshake before making the injection decision.
23. If Codex explicitly calls `iranti_write` for a personal-memory key such as `favorite_book`, the MCP server reroutes that write to the configured canonical personal entity instead of allowing project-local identity forks like `user/nf` vs `user/main`.
24. Recall questions about remembered preferences, decisions, blockers, next steps, or prior project facts are treated as mandatory memory prompts and bypass the LLM memory-needed classifier.
25. Handshake may also return a backfill suggestion when recent messages appear to contain durable facts that have not yet been persisted.
26. If Codex's own final answer contains a strict durable summary such as `The next step is ...` or `We decided ...`, call `iranti_remember_response` explicitly because there is no Codex-side `Stop` hook.
27. Launch Codex with `codex -C <project>` for the intended workspace context.

## Edge Cases

- If `codex` is not installed, setup fails fast with a direct error that tells the user to confirm `codex --version` before retrying.
- Direct terminal launch of `iranti mcp`: the process intentionally stays running because it is waiting for a stdio MCP client; this is not a crash or deadlock.
- If `codex --version` works in PowerShell on Windows but PATH resolution still differs for child-process execution, `CODEX_CLI_PATH` may be used to pin Iranti to a concrete `codex.exe` or npm shim target.
- Setup succeeds without `--project-env`; the MCP server then relies on runtime cwd-based resolution.
- If `--project-env` points to a missing file, setup fails fast.
- If the installed `iranti` CLI does not expose `iranti mcp`, setup can fall back to `--local-script`.
- If `dist/scripts/iranti-mcp.js` is missing in `--local-script` mode, setup fails and instructs the user to run `npm run build`.
- If a prior MCP entry exists, setup replaces it so reruns are deterministic.
- If a project-local `.mcp.json` or `.vscode/mcp.json` already exists, setup merges the `iranti` entry without removing unrelated MCP servers.
- If a bound project cannot be resolved from the current working directory and `--project-env` is not supplied, setup leaves the global registration intact and skips the workspace-file write.
- If `.mcp.json` exists but `.vscode/mcp.json` is missing, Codex CLI may still work while Codex VS Code sessions fail to expose `iranti` tools.
- `DATABASE_URL` is not written into Codex config; the MCP process resolves `.env.iranti` and linked instance env at runtime instead.
- `IRANTI_AUTO_REMEMBER=true` without `IRANTI_MEMORY_ENTITY`: project-scoped auto-write is skipped rather than guessing an entity; personal facts still default to `user/main`.
- Auto-remember ignores arbitrary narrative turns and only captures strict explicit prompt patterns.
- `iranti_remember_response` also ignores arbitrary prose and persists only strict assistant-summary patterns.
- In multi-repo setups, the default unpinned registration avoids accidentally pinning all Codex sessions to one repo's `.env.iranti`.
- If the active project is missing `.env.iranti` or `IRANTI_INSTANCE_ENV`, MCP startup fails when Codex tries to connect.

## Test Results

- `npm run build` passes with the updated Codex setup script included.
- `npm run test:mcp-smoke` exercises `iranti_remember_response` and verifies it persists `next_step`.
- `iranti codex-setup` successfully registers `iranti` in Codex MCP config.
- `iranti codex-setup` writes or merges project-local `.mcp.json` and `.vscode/mcp.json` files when run from a bound project.
- `iranti integrate codex` resolves to the same setup path.
- `codex mcp get iranti` returns the expected installed-command MCP entry.

## Related

- `scripts/codex-setup.ts`
- `scripts/iranti-cli.ts`
- `scripts/iranti-mcp.ts`
- `docs/guides/codex.md`
- `docs/guides/claude-code.md`
