# CLI Configure

## Overview

`iranti configure` updates named instance env files and project binding files without requiring users to hand-edit `.env` files. It is intended for both first-run onboarding and later changes such as provider switches, key rotation, port updates, and project rebinding.

## Inputs

| Input | Type | Description |
|---|---|---|
| `configure instance <name>` | command | Targets a named machine-level instance. |
| `--db-url` | string | Replaces `DATABASE_URL` in the instance env. |
| `--port` | integer | Replaces `IRANTI_PORT` in the instance env. |
| `--api-key` | string | Replaces `IRANTI_API_KEY` in the instance env or project binding. |
| `--provider` | string | Replaces `LLM_PROVIDER` in the instance env. |
| `--provider-key` | string | Writes the provider-specific remote API key for the selected provider. |
| `--clear-provider-key` | boolean | Removes the selected provider's remote API key from the instance env. |
| `--interactive` | boolean | Prompts for configuration values in the terminal instead of requiring every flag up front. |
| `configure project [path]` | command | Targets `.env.iranti` in a project directory. |
| `--instance` | string | Rebinds the project to a named instance and derives local URL/env metadata from it. |
| `--url` | string | Explicitly sets `IRANTI_URL` for a project binding. |
| `--agent-id` | string | Replaces `IRANTI_AGENT_ID` in the project binding. |
| `--memory-entity` | string | Replaces `IRANTI_MEMORY_ENTITY` in the project binding. |
| `--json` | boolean | Emits machine-readable output. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Updated env file | file | Rewritten instance `.env` or project `.env.iranti` with requested changes applied. |
| Command summary | text | Human-readable summary of what changed. |
| Command summary | JSON | Structured output containing target file and updated settings. |

## Decision Tree / Flow

1. Resolve the target:
   - `configure instance` loads a named instance env under the runtime root.
   - `configure project` loads or creates `.env.iranti` under the selected project path.
2. Validate user-supplied flags:
   - parse and validate `--port`
   - normalize provider names
   - map provider names to the correct provider API key env variable
   - if `--interactive` is enabled, prompt for missing/current values before applying updates
3. Merge requested updates into the env file while preserving unrelated keys and comments where possible.
4. For project bindings:
   - derive `IRANTI_URL` and `IRANTI_INSTANCE_ENV` from the named instance when `--instance` is provided
   - preserve existing values when the user does not override them
5. Write the resulting env file and ensure `.env.iranti` is listed in `.gitignore` for project bindings.
6. Emit text or JSON output.

## Edge Cases

- `configure instance` fails if the named instance does not exist.
- `--provider-key` fails for providers that do not use remote API keys (`mock`, `ollama`).
- `--interactive` requires a real terminal session and is not intended for piped/non-TTY automation.
- Interactive secret entry is masked in the terminal, but it is still intended for local onboarding rather than non-interactive automation.
- `configure project` can create a new `.env.iranti`, but it requires either an existing instance or an explicit `--url` plus `--api-key`.
- Existing project bindings retain their current agent identity and memory entity unless new values are provided.

## Test Results

- TypeScript build passes with the new CLI command surface included.
- Temporary runtime-root smoke tests confirm instance creation, instance reconfiguration, and project binding updates execute without manual file edits.

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/quickstart.md`
- `README.md`
