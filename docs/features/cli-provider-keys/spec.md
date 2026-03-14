# CLI Provider Keys

## Overview
Iranti exposes installed-package CLI commands for listing, adding, updating, and removing upstream provider API keys without requiring users to open instance `.env` files manually. The commands work against either a named instance or a project-bound instance resolved through `.env.iranti`.

## Inputs

| Input | Type | Description |
|---|---|---|
| `provider` | `string` | Remote provider name such as `openai`, `claude`, `gemini`, `groq`, or `mistral`. |
| `--instance` | `string` | Named Iranti instance whose env file should be updated. |
| `--project` | `string` | Project directory containing `.env.iranti` used to resolve `IRANTI_INSTANCE_ENV`. |
| `--key` | `string` | Provider API key to store or update. |
| `--set-default` | `boolean` | Also update `LLM_PROVIDER` to match the selected provider. |
| `--json` | `boolean` | Emit machine-readable JSON instead of terminal-oriented text. |

## Outputs

| Output | Type | Description |
|---|---|---|
| provider status list | text / JSON | Shows which provider keys are stored and which provider is the current default without exposing raw secret values. |
| success summary | text / JSON | Confirms the provider key was stored, updated, or removed and shows the target env file. |
| masked secret display | text | Redacts the stored value in terminal output. |

## Decision Tree / Flow
1. Resolve the target env file from `--instance`, or from `.env.iranti` plus `IRANTI_INSTANCE_ENV` when `--project` or the current working directory is bound.
2. Resolve the provider from the positional argument or `--provider`; if missing and running in a TTY, prompt the user interactively.
3. Validate that the provider uses a remote API key.
4. For add/update:
5. Accept `--key` directly or prompt for a hidden secret in a real terminal.
6. Reject placeholders or blank values.
7. Write the corresponding provider env key into the instance env file.
8. If `--set-default` is present, or no usable default provider exists yet, also set `LLM_PROVIDER`.
9. For remove:
10. Delete the provider env key from the target env file if it is currently set.
11. Render terminal output with colored status labels when a TTY is available, or JSON when requested.

## Edge Cases
- If no target instance can be resolved, the command fails with an explicit message telling the user to pass `--instance` or run from a bound project.
- `mock` and `ollama` are rejected for add/update/remove because they do not use remote API keys.
- Perplexity is shown in the list as not yet supported rather than pretending it is configurable.
- Non-interactive sessions must provide `--key`; hidden prompting is only used in real terminals.
- Removing a key that is not present returns a warning instead of mutating the file.

## Test Results
- `npm run build` completed successfully.
- `node dist/scripts/iranti-cli.js list api-keys --instance local --json` returned provider-key status for a real local instance.
- `node dist/scripts/iranti-cli.js add api-key openai --instance local --key test_value --json` wrote the expected env key in a disposable test instance flow.
- `node dist/scripts/iranti-cli.js remove api-key openai --instance local --json` removed the stored env key in the same disposable test flow.

## Related
- [`scripts/iranti-cli.ts`](C:\Users\NF\Documents\Projects\iranti\scripts\iranti-cli.ts)
- [`docs/guides/quickstart.md`](C:\Users\NF\Documents\Projects\iranti\docs\guides\quickstart.md)
- [`README.md`](C:\Users\NF\Documents\Projects\iranti\README.md)
