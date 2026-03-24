# CLI Status

## Overview

`iranti status` provides a compact view of the current Iranti runtime layout from the active machine and working directory. It now includes per-instance runtime metadata, config-state classification, health-backed runtime truth, and runtime-root provenance so operators can see which instance processes are actually healthy, which ones are stale, which instance directories are partially broken, which runtime root was selected, and when the current project binding points at a different root than the active CLI selection. It is intended as a quick operational summary rather than a validation tool.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--scope` | string | Optional runtime scope for resolving the runtime root. Accepts `user` or `system`. |
| `--json` | boolean | Output machine-readable JSON instead of human-readable text. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Runtime summary | text | Current package version, runtime root, root source, optional bound runtime root, repo env, project binding, install metadata, known instances, per-instance config state, and live runtime state. |
| Runtime summary | JSON | Structured status payload for scripts or automation, including per-instance runtime metadata, health results, config-state classification, runtime-root provenance, root-mismatch hints, per-instance repair hints, and aggregated recommended actions. |

## Decision Tree / Flow

1. Resolve the active runtime root from `--root`, `IRANTI_HOME`, scope, project binding ancestry, local runtime ancestry, and install metadata, and record where that choice came from.
2. Detect the nearest ancestor `.env` and `.env.iranti` files from the current working directory rather than requiring the operator to be at repo root.
3. If the nearest `.env.iranti` points at a linked instance env, derive the bound runtime root from that path.
4. Detect runtime install metadata under the selected root.
5. Enumerate named instances under `<root>/instances`.
6. For each instance, inspect `.env` plus `instance.json` to classify configuration state.
7. For each instance, inspect `runtime.json`, check PID liveness, and when a process is alive probe the health endpoint before classifying the runtime as healthy or unhealthy.
8. Output either text or JSON.

## Edge Cases

- If no install metadata exists, status still reports the inferred runtime root and marks install metadata as missing.
- If status runs from a nested subdirectory inside a bound project, it still resolves the parent `.env.iranti` and parent runtime root correctly.
- If the current project binding points at a different runtime root than the active CLI root, status reports both roots and flags the mismatch instead of silently hiding it.
- If no instances exist, status prints `Instances: none`.
- If an instance directory is missing `.env` or `instance.json`, status marks config as `PARTIAL`.
- If `.env` or `instance.json` is unreadable, status marks config as `INVALID`.
- If `instance.json` points at a different instance name, env file, or instance directory than the directory being inspected, status marks config as `INVALID`.
- If an instance env file exists but cannot be parsed, the port is reported as unknown.
- If runtime metadata exists but the recorded PID is no longer alive, status marks the instance as `STALE` rather than `RUNNING`.
- If runtime metadata claims `stopped` but the recorded PID is still alive, status marks the instance runtime as `INVALID` instead of trusting contradictory metadata.
- If a PID is alive but the health endpoint does not respond successfully, status marks the runtime as `UNHEALTHY` rather than `RUNNING`.
- If `runtime.json` exists but is unreadable or incomplete, status marks the instance runtime as `INVALID` instead of pretending it is merely stopped.
- If `runtime.json` points at a different runtime file, env file, instance dir, or instance name than the directory being inspected, status marks the runtime as `INVALID` instead of trusting foreign metadata.

## Test Results

- `iranti status` reports repo-local env files when run inside the repo.
- `iranti status --json` emits structured machine-readable output.
- `iranti status` lists machine-level instances when present.
- `iranti status` now prints runtime state for each instance, including running/unhealthy/stale/stopped/invalid classification plus per-instance config state.
- `iranti status --json` reports runtime-root source plus bound-root mismatch information when a project binding points at a different root.
- `iranti status --json` resolves project bindings and local runtime roots correctly from nested subdirectories.
- `iranti status --json` distinguishes complete/partial/invalid instance config and healthy/unhealthy runtimes.
- `iranti status --json` includes per-instance repair hints plus aggregated recommended actions when operator intervention is needed.

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/quickstart.md`
- `docs/features/cli-doctor/spec.md`
