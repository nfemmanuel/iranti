# CLI Uninstall

## Overview

`iranti uninstall` removes the installed Iranti package surface and can optionally tear down runtime data plus project-local integration files. The command is intentionally conservative by default: package removal and process shutdown happen first, while destructive data cleanup only happens when the operator opts into `--all`.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--scope` | enum | Selects the active runtime root when `--root` is not provided. |
| `--root` | string | Explicit runtime root to inspect and, with `--all`, remove. |
| `--dry-run` | boolean | Print the uninstall inventory and plan without mutating anything. |
| `--yes` | boolean | Execute the uninstall non-interactively. |
| `--all` | boolean | Remove discovered runtime roots, project bindings, Claude/Codex integration files, and Codex MCP registration in addition to package installs. |
| `--keep-data` | boolean | Preserve runtime roots even when `--all` is selected. |
| `--keep-project-bindings` | boolean | Preserve `.env.iranti`, `.mcp.json` Iranti entries, and Claude hook settings even when `--all` is selected. |
| `--scan-root` | string/list | Comma-separated roots to scan for project bindings and isolated `.iranti-runtime` folders. Defaults to the current directory and `~/Documents/Projects` when present. |
| `--json` | boolean | Emit machine-readable uninstall inventory, action plan, and execution result. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Uninstall summary | text | Human-readable inventory of runtime roots, live processes, project artifacts, and planned removals. |
| Uninstall summary | JSON | Structured uninstall inventory, action flags, plan, and execution result. |
| Execution result | text | Per-step success/warn/fail lines for process shutdown, package uninstall, project cleanup, and runtime-root deletion. |

## Decision Tree / Flow

1. Detect the active install context:
   - runtime root
   - global npm install
   - Python client install
   - Codex MCP registration
2. Resolve scan roots.
3. If `--all` and project cleanup is enabled, discover:
   - `.env.iranti`
   - `.mcp.json` files with an `iranti` MCP entry
   - `.claude/settings.local.json` files with Iranti Claude hooks
4. Derive runtime roots from:
   - the active root
   - project bindings that point to `IRANTI_INSTANCE_ENV`
   - scanned `.iranti-runtime` / `.iranti` directories
5. Collect live Iranti processes from runtime metadata plus best-effort process scanning.
6. Build the uninstall plan:
   - stop live processes
   - remove global npm install
   - remove Python client
   - remove Codex MCP registration
   - optionally remove project bindings/integration files
   - optionally delete runtime roots
7. If no execution flag is provided in a TTY, prompt for confirmation once.
8. If `--dry-run`, print the plan and exit without mutation.
9. If running on Windows from a live global npm install, hand off to a detached PowerShell uninstaller so the current CLI can exit before `npm uninstall -g iranti` runs.
10. Otherwise execute in-process:
   - stop processes
   - uninstall packages
   - remove project artifacts while preserving unrelated MCP servers or Claude settings
   - delete runtime roots when allowed

## Edge Cases

- Default mode is intentionally non-destructive for data: it removes packages/processes but keeps runtime data and project bindings unless `--all` is supplied.
- `.mcp.json` and `.claude/settings.local.json` are edited surgically; unrelated MCP servers and Claude settings are preserved.
- Invalid JSON in project integration files is treated as a warning, not a hard failure.
- Best-effort process scanning may miss some Iranti processes; runtime-metadata-backed instance processes are still handled directly.
- On Windows, self-uninstall from a live global npm install is detached instead of attempting an in-place uninstall that would fail while the CLI binary is still running.
- Detached Windows uninstall resolves helper executables such as `npm` and `codex` to concrete absolute paths before launching the PowerShell handoff.

## Test Results

- `npx ts-node tests/runtime-lifecycle/run_uninstall_tests.ts`
  - plain `uninstall --yes --json` removed npm/Python package surfaces but preserved runtime roots, `.env.iranti`, `.mcp.json`, and Claude hook files
  - `uninstall --all --dry-run --json` reported destructive cleanup targets without mutating them
  - `uninstall --all --yes --json` removed runtime roots and project-local Iranti artifacts while preserving unrelated MCP servers and Claude hook entries
- `npx tsc --noEmit`

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/manual.md`
- `docs/features/cli-upgrade/spec.md`
