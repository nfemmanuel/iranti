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
| Diagnostic summary | JSON | Structured object containing overall status and individual checks. |
| Exit code | integer | `0` when all checks pass, `1` when any warning or failure is present. |

## Decision Tree / Flow

1. Resolve the env source in this order:
   - explicit `--env`
   - named `--instance`
   - current directory `.env`
   - current directory `.env.iranti`
2. Check Node major version.
3. Check whether the built CLI artifact exists.
4. Check whether the selected env file exists and can be parsed.
5. Validate key environment fields:
   - `DATABASE_URL`
   - `IRANTI_API_KEY` or `IRANTI_URL` for project bindings
   - `LLM_PROVIDER`
   - provider-specific API key when required
6. Emit a combined status:
   - `pass` if all checks pass
   - `warn` if no failures but at least one warning exists
   - `fail` if any required check fails

## Edge Cases

- If no env file can be found automatically, doctor fails fast with a clear message.
- Placeholder values such as `yourpassword` and `replace_me_with_api_key` are treated as invalid configuration.
- `mock` and `ollama` are treated as local providers and do not require a remote API key.
- Unknown providers produce a warning instead of a hard failure because doctor cannot infer the key contract.
- The CLI build artifact check warns in ts-node/dev flows instead of failing.

## Test Results

- `iranti doctor` works against repo `.env`, project `.env.iranti`, and named instance env files.
- `iranti doctor --json` emits machine-readable status for scripting and CI checks.
- Build and packaging smoke tests continue to pass with the new command included.

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/quickstart.md`
- `docs/operations/PRE_LAUNCH_CHECKLIST.md`
