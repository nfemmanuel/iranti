# CLI Upgrade

## Overview

`iranti upgrade` detects the current install context, compares the local CLI version against the latest published npm/PyPI versions, prints the exact upgrade plan, and can execute the selected upgrade path safely when explicitly confirmed. It also reports live Iranti instance processes so the operator can see which runtimes will continue running the old version until they are restarted.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--check` | boolean | Inspect install mode and latest versions without executing anything. |
| `--dry-run` | boolean | Print the exact command plan without executing it. |
| `--yes` | boolean | Execute the selected upgrade path non-interactively. |
| `--all` | boolean | Select every detected executable upgrade surface. |
| `--target` | enum/list | Force `auto`, `npm-global`, `npm-repo`, or `python`, optionally comma-separated. |
| `--json` | boolean | Output machine-readable upgrade state, plan, running-instance inventory, and execution result. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Upgrade summary | text | Human-readable current/latest versions, detected install mode, and the selected command plan. |
| Upgrade summary | JSON | Structured machine-readable install detection, version state, plan, running-instance inventory, and execution result. |
| Execution result | text | Success/warn/fail verification after a real upgrade run. |

## Decision Tree / Flow

1. Detect the current package root, runtime root, repo checkout state, npm-global state, and available Python launcher.
2. Fetch the latest published npm and PyPI versions when reachable.
3. Choose an upgrade target:
   - explicit `--target` wins
   - otherwise prefer repo checkout, then npm-global, then Python
4. If no execution flag is provided and a TTY is available, prompt the user target-by-target:
   - upgrade global npm install?
   - refresh local repo checkout?
   - upgrade Python client?
5. Build the exact command plan for the selected targets.
6. If `--check` or `--dry-run`, print the plan without mutating the environment.
7. If `--yes`, run the plan:
   - `npm-repo`: `git pull --ff-only`, `npm install`, `npm run build`
   - `npm-global`: `npm install -g iranti@latest`
   - `python`: `python -m pip install --upgrade iranti` (or `py -3 -m pip ...` on Windows)
8. On Windows, if the currently running CLI is the same global npm install being upgraded, hand off the npm-global step to a detached updater process instead of attempting an in-place self-replacement that would fail with `EBUSY`.
9. Resolve detached executables to concrete absolute paths before scheduling the PowerShell handoff; do not rely on a raw PATH token in the detached script.
10. If `--restart --instance <name>` is also requested on that detached Windows path, generate the restart step from structured instance metadata rather than injecting an arbitrary post-command string.
11. When `iranti instance restart` runs directly, wait for the replacement runtime to become healthy before reporting success.
12. Verify the result:
   - npm-global via `npm list -g iranti`
   - Python via `pip show iranti`
   - repo target by requiring the build to complete successfully
13. If the repo worktree is dirty, block `npm-repo --yes` rather than risking a destructive pull.
14. After a successful or scheduled global npm upgrade, remind the user that an already-running old CLI process may need a fresh shell to pick up the new binary.
15. Read runtime metadata for known instances under the active runtime root and report which ones are currently running versus stale or stopped.

## Edge Cases

- Latest-version lookups are best-effort; unreachable registries degrade to `(unavailable)` rather than failing the command.
- `npm-repo --yes` refuses to run on a dirty worktree.
- Interactive mode only runs in a real TTY; otherwise the command stays informational unless `--yes` is supplied.
- `--all` runs every detected executable target, but unavailable or blocked surfaces are skipped rather than treated as fatal.
- If no executable target is detected automatically, the command stays informational until the user passes an explicit supported `--target`.
- `--dry-run` and `--check` always skip mutation even if `--yes` is also present.
- After `npm install -g`, the already-running old CLI process may still be the binary handling the current command; the command prints a handoff hint instead of pretending that process replaced itself.
- On Windows, when the running CLI itself is the global npm install being upgraded, the npm-global step is scheduled in a detached updater process to avoid `EBUSY` rename failures.
- Detached Windows handoff resolves `npm`, `iranti`, and related executables to absolute paths before launch.
- Detached Windows restart follow-up is generated from typed instance metadata rather than a free-form post-command string.
- `iranti instance restart` now fails if the replacement process never becomes healthy; it no longer reports success immediately after the detached child is spawned.
- If runtime metadata reports live instances, upgrade output lists them so the operator can tell whether a restart will be needed for those running runtimes to pick up a newly installed version.

## Test Results

- `npx ts-node scripts/iranti-cli.ts upgrade --check --json`
- `npx ts-node scripts/iranti-cli.ts upgrade --target npm-repo --dry-run`
- `npx ts-node scripts/iranti-cli.ts upgrade --all --dry-run`
- `npx ts-node tests/runtime-lifecycle/run_setup_upgrade_tests.ts`
  - `upgrade --yes --target npm-global,python --json` executed against fake tool shims
  - npm-global and python verification both returned `pass`
  - runtime install metadata recorded `upgradedAt`
- `npx tsc --noEmit`
- `node -r ts-node/register/transpile-only tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts`

## Related

- `scripts/iranti-cli.ts`
- `README.md`
- `docs/guides/quickstart.md`
- `docs/features/cli-status/spec.md`
