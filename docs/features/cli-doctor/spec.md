# CLI Doctor

## Overview

`iranti doctor` provides lightweight environment and configuration diagnostics for repository installs, project bindings, and named machine-level instances. It is intended to catch obvious setup and release issues before a user attempts to run the API server or bind a project.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--instance` | string | Optional named instance to inspect under the Iranti runtime root. |
| `--scope` | string | Optional runtime scope for resolving named instances. Accepts `user` or `system`. |
| `--env` | string | Optional explicit env file path to inspect. |
| `--json` | boolean | Output machine-readable JSON instead of human-readable text. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Diagnostic summary | text | Human-readable list of pass/warn/fail checks. |
| Diagnostic summary | JSON | Structured object containing overall status, individual checks, and an additive `authority` summary for the active binding/env and database target, including nearby binding authority when repo `.env` is selected. |
| Runtime-root discovery | JSON | Additive `selectedRuntimeRoot`, `boundRuntimeRoot`, `rootMismatch`, `otherRuntimeRoots`, and `discovery` fields for project-binding diagnostics. |
| Exit code | integer | `0` when all checks pass, `1` when any warning or failure is present. |

## Decision Tree / Flow

1. Resolve the env source in this order:
   - explicit `--env`
   - named `--instance`
   - nearest ancestor env target discovered while walking outward from the current working directory
     - if both `.env` and `.env.iranti` exist in the same directory, prefer `.env`
     - a closer `.env.iranti` beats a farther ancestor `.env`
2. Check Node major version.
3. Check whether the built CLI artifact exists.
4. Check whether the selected env file exists and can be parsed.
5. Validate key environment fields:
   - `DATABASE_URL`
   - `IRANTI_API_KEY` or `IRANTI_URL` for project bindings
   - `LLM_PROVIDER`
   - provider-specific API key when required
6. Build an operator-facing authority summary:
   - active binding source, when a `.env.iranti` binding governs the command
   - active bound instance env, when the binding delegates to one
   - active database URL and parsed database target
   - repo-local `.env` database target when it differs from the active authority
   - nearby project-binding source / bound database target when repo `.env` is selected but a sibling or ancestor `.env.iranti` points at a different bound-instance database
7. For project bindings, compare the selected runtime root to the bound instance runtime root:
   - emit a warning when the current doctor target points at a different runtime root than the project binding
   - include additive runtime-root discovery fields in `--json` output for automation
8. Evaluate startup/operator invariants:
   - production envs fail the check if `IRANTI_API_KEY_PEPPER` is missing or too short
   - insecure production overrides are surfaced as warnings
   - explicit runtime authority mismatches are surfaced as failures
9. Probe the configured vector backend:
   - report reachability
   - when reachable, audit vector index consistency against `knowledge_base`
10. Emit a combined status:
   - `pass` if all checks pass
   - `warn` if no failures but at least one warning exists
   - `fail` if any required check fails

## Edge Cases

- If no env file can be found automatically, doctor fails fast with a clear message.
- Placeholder values such as `yourpassword` and `replace_me_with_api_key` are treated as invalid configuration.
- `mock` and `ollama` are treated as local providers and do not require a remote API key.
- Unknown providers produce a warning instead of a hard failure because doctor cannot infer the key contract.
- The CLI build artifact check warns in ts-node/dev flows instead of failing.
- Unreachable configured vector backends are failures because embedding-backed retrieval is materially degraded.
- Reachable vector backends can still warn if the vector index has drifted from `knowledge_base`.

## Test Results

- `iranti doctor` works against repo `.env`, project `.env.iranti`, and named instance env files.
- `iranti doctor` auto-discovers repo and project binding env files from nested subdirectories, not only the immediate cwd.
- `iranti doctor` prefers the nearest ancestor env target, so a closer `.env.iranti` is not overridden by a farther repo `.env`.
- `iranti doctor --json` emits machine-readable status for scripting and CI checks.
- `iranti doctor --json` reports runtime-root mismatch details for project bindings, including the selected root and alternate bound root.
- `iranti doctor` and `iranti doctor --json` surface the active authority chain, bound instance env, active database target, and the differing repo-local `.env` database target when one exists.
- `iranti doctor` now also warns when repo `.env` is the active doctor target but a nearby `.env.iranti` points at a different bound-instance database.
- Vector backend consistency warnings are emitted when embeddings are missing or orphaned vectors are present.
- Build and packaging smoke tests continue to pass with the new command included.

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/quickstart.md`
- `docs/operations/PRE_LAUNCH_CHECKLIST.md`
