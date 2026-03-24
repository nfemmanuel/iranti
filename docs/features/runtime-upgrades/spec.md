# Runtime Upgrades

## Overview
Iranti supports upgrading while API servers, MCP servers, or other Iranti-managed processes are running, but it does not rely on in-place mutation of the currently executing install directory. The implemented model is staged side-by-side installation plus a supervised restart or handoff, with runtime metadata written per instance so the CLI can observe which processes are still on an older version and restart them explicitly when requested. This avoids Windows file-lock failures, reduces runtime fragility, and gives the CLI a safe upgrade story even when long-lived Iranti processes are active.

## Inputs

| Input | Type | Description |
|---|---|---|
| `iranti upgrade` | CLI command | Detects newer published versions and stages the selected runtime update. |
| `iranti instance restart <name>` | CLI command | Restarts a running instance using its runtime metadata. |
| `--target` | enum/list | Chooses which install surfaces should be updated: `npm-global`, `npm-repo`, `python`. |
| `--restart` | boolean | Requests a supervised instance restart after staging the new runtime. |
| `--instance <name>` | string | Declares which Iranti instance should be restarted or handed off after staging. |
| `--graceful-timeout <seconds>` | integer | Maximum time to wait for a running process to drain before forcing restart. |
| live process inventory | runtime state | Live or stale runtime metadata for instance-backed API servers detected under the active runtime root. |
| instance metadata | runtime config | Runtime root, managed-runtime authority, installed version, target version, PID records, and health endpoints. |

## Outputs

| Output | Type | Description |
|---|---|---|
| staged runtime version | filesystem | New version installed side-by-side with the currently running version. |
| active runtime pointer | filesystem/config | Stable launcher or metadata pointer that determines which version new launches use. |
| restart plan | text/JSON | Explicit summary of what will be restarted, what will remain running temporarily, and which version becomes active. |
| graceful handoff result | text/JSON | Outcome of supervised restart, including health verification on the new version. |
| cleanup record | filesystem/config | Metadata allowing old runtime versions to be removed after a healthy cutover. |
| instance runtime record | filesystem | `runtime.json` under each instance directory, used for observability and restart gating. |

## Decision Tree / Flow
1. Detect the currently active install surface and the latest available target version.
2. Detect running instance-backed API server processes via `runtime.json` metadata.
3. If the selected upgrade target is a repo checkout, keep the current repo-based behavior and do not try to supervise package handoff.
4. If the selected upgrade target is a packaged runtime:
   - install the new version into a side-by-side versioned location
   - do not overwrite the currently executing directory in place
5. Update the stable launcher metadata so new Iranti launches resolve to the staged version.
6. If `--restart` is not requested:
   - report that the new version is staged
   - tell the user which processes are still running the old version
   - mark the instance as needing restart for full activation
7. If `--restart` is requested:
   - locate the target instance process
   - request graceful shutdown
   - wait up to the configured timeout
   - if the old process exits, start the instance under the staged version
   - verify health on the new process before declaring success
8. If an MCP server is attached to long-lived clients:
   - do not pretend those clients hot-swapped in place
   - mark them as requiring client reconnect
9. Once the new API process is healthy, mark the staged version active and record the prior version as cleanup-eligible.
10. Do not remove the old staged version automatically until:
   - the new version is healthy
   - no live processes still reference the old version
   - or a later cleanup command explicitly prunes it
11. Resolve runtime authority from explicit instance env/runtime vars first, then from well-formed runtime paths such as `<instance>/escalation` or `<instance>/logs/api-requests.log`.
12. If managed runtime authority is invalid or ambiguous, do not silently write runtime metadata to an inferred location.
13. If managed runtime authority is explicitly invalid, fail startup instead of logging and continuing.
14. When `iranti run --instance <name>` starts an API server, write runtime metadata with PID, port, version, and health URL.
15. When `iranti instance restart <name>` is invoked, refuse to restart stale or stopped instances and only restart instances that are actually running.
16. After spawning the replacement runtime, wait for healthy runtime metadata before returning success.

## Edge Cases

- Windows file locking must never be treated as a recoverable in-place overwrite path; staged side-by-side installs are the baseline behavior.
- If active Iranti processes are detected but `--restart` is omitted, upgrade should succeed as a staging operation but clearly report that the running processes are still on the old version.
- If the old process does not exit within the graceful timeout, the command should stop and report the exact blocking PIDs unless the user explicitly chooses a forceful restart path.
- If the new version stages successfully but fails health checks after restart, the system should keep enough metadata to relaunch the previous version.
- `npm-global`, `python`, and repo-checkout installs may coexist; the command must describe exactly which surface was staged and which runtime the instance actually uses.
- Client-facing tools such as Claude Code or Codex may keep an MCP process alive; those clients must reconnect rather than expecting a magical hot swap.
- The feature does not promise zero downtime. It promises safe staged upgrades plus predictable restart or handoff.
- `iranti instance restart` only operates on a live instance process; stale runtime metadata is reported but not restarted.
- `iranti instance restart` only reports success after the replacement runtime becomes healthy; a detached child that exits early is treated as a failed restart.
- Invalid runtime metadata should be classified as invalid, not coerced into `running`.
- Managed startup must fail if the initial runtime metadata write fails; a managed instance without trustworthy runtime metadata is not considered healthy.
- Production startup must fail fast when runtime/security invariants required for operator trust are missing.

## Test Results

- `npx tsc --noEmit`
- `node -r ts-node/register/transpile-only tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts`
- Runtime metadata is now written to `runtime.json` for live instances.
- Runtime authority is now resolved from a canonical explicit-or-derived model rather than loosely inferred from any nearby path.
- `iranti status --json` reports running versus stale instance state.
- `iranti instance restart <name>` refuses to operate on stale metadata and only restarts live instances.
- `iranti instance restart <name>` fails when the replacement runtime cannot become healthy instead of reporting a scheduled restart as success.

## Related

- `scripts/iranti-cli.ts`
- `bin/iranti.js`
- `docs/features/cli-upgrade/spec.md`
- `docs/guides/manual.md`
- `docs/decisions/006-runtime-lifecycle-safety.md`
- `src/lib/runtimeLifecycle.ts`
