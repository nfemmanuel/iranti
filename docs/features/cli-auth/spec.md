# CLI Auth

## Overview

`iranti auth` exposes registry-backed API key lifecycle operations through the main CLI. It replaces the older pattern of remembering standalone npm scripts for create/list/revoke flows and allows generated tokens to be synced directly into named instances or project bindings.

## Inputs

| Input | Type | Description |
|---|---|---|
| `auth create-key` | command | Creates or rotates a registry-backed API key token. |
| `--instance` | string | Named instance whose `DATABASE_URL` should be used for the registry operation. |
| `--key-id` | string | Stable key identifier. Reusing it rotates the key. |
| `--owner` | string | Human-readable owner label stored in the registry. |
| `--scopes` | string | Comma-separated scope list such as `kb:read,memory:write`. |
| `--description` | string | Optional metadata attached to the registry record. |
| `--write-instance` | boolean | Writes the generated token into the instance env as `IRANTI_API_KEY`. |
| `--project` | string | Optional project path whose `.env.iranti` should be updated with the generated token. |
| `--agent-id` | string | Optional project agent id used when creating a new binding during `--project` sync. |
| `auth list-keys` | command | Lists registry-backed API keys for the selected instance database. |
| `auth revoke-key` | command | Marks a registry-backed key inactive. |
| `--json` | boolean | Emits machine-readable output. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Token | text | Newly created `keyId.secret` token, printed once. |
| Registry summary | text | Human-readable list or revoke confirmation. |
| Registry summary | JSON | Machine-readable result for automation. |
| Synced env file | file | Optional updates to instance/project env files when sync flags are used. |

## Decision Tree / Flow

1. Resolve the named instance and load its env file.
2. Require a non-placeholder `DATABASE_URL`, because the registry lives in the Library.
3. Initialize the DB client for the instance database.
4. Execute one of:
   - create/rotate a key
   - list keys
   - revoke a key
5. On create:
   - print the token once
   - optionally sync it into the instance env
   - optionally sync it into a project binding
6. Disconnect the DB client before exit.

## Edge Cases

- Commands fail fast when the instance does not exist or still uses a placeholder `DATABASE_URL`.
- `create-key` is idempotent for `keyId` in the sense that rerunning it rotates the secret and replaces the prior registry record.
- Project sync preserves an existing project binding's current `IRANTI_AGENT_ID` and `IRANTI_MEMORY_ENTITY` unless the user overrides them.
- Revoking a non-existent key returns a clear error.

## Test Results

- TypeScript build passes with the new CLI auth commands included.
- The command flow reuses the same registry APIs as the existing standalone helper scripts, keeping validation behavior aligned with the server auth middleware.

## Related

- `scripts/iranti-cli.ts`
- `scripts/api-key-create.ts`
- `scripts/api-key-list.ts`
- `scripts/api-key-revoke.ts`
- `src/security/apiKeys.ts`
