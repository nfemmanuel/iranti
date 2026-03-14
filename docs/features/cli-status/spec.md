# CLI Status

## Overview

`iranti status` provides a compact view of the current Iranti runtime layout from the active machine and working directory. It is intended as a quick operational summary rather than a validation tool.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--scope` | string | Optional runtime scope for resolving the runtime root. Accepts `user` or `system`. |
| `--json` | boolean | Output machine-readable JSON instead of human-readable text. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Runtime summary | text | Current package version, runtime root, repo env, project binding, install metadata, and known instances. |
| Runtime summary | JSON | Structured status payload for scripts or automation. |

## Decision Tree / Flow

1. Resolve the active runtime root from scope and install metadata.
2. Detect local `.env` and `.env.iranti` files in the current working directory.
3. Detect runtime install metadata under the selected root.
4. Enumerate named instances under `<root>/instances`.
5. For each instance, read `.env` if present and surface the configured port.
6. Output either text or JSON.

## Edge Cases

- If no install metadata exists, status still reports the inferred runtime root and marks install metadata as missing.
- If no instances exist, status prints `Instances: none`.
- If an instance env file exists but cannot be parsed, the port is reported as unknown.

## Test Results

- `iranti status` reports repo-local env files when run inside the repo.
- `iranti status --json` emits structured machine-readable output.
- `iranti status` lists machine-level instances when present.

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/quickstart.md`
- `docs/features/cli-doctor/spec.md`
