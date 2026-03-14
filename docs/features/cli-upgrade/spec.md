# CLI Upgrade

## Overview

`iranti upgrade` provides the canonical upgrade paths for the npm package, local repository installs, and the Python client. It is intentionally advisory for now: it prints the correct commands rather than trying to self-update the current environment.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--json` | boolean | Output machine-readable JSON containing upgrade commands. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Upgrade guidance | text | Human-readable commands for npm global installs, repo installs, and Python client upgrades. |
| Upgrade guidance | JSON | Structured machine-readable command set. |

## Decision Tree / Flow

1. Read the current package version.
2. Build a static set of supported upgrade commands:
   - npm global install
   - repo checkout refresh
   - Python client upgrade
3. Emit text or JSON output.
4. Do not mutate the current installation.

## Edge Cases

- The command does not attempt package-manager detection; it always prints all supported upgrade paths.
- The command does not self-update in place, which avoids destructive or environment-specific behavior.

## Test Results

- `iranti upgrade` prints valid upgrade commands.
- `iranti upgrade --json` emits structured upgrade data for scripting.

## Related

- `scripts/iranti-cli.ts`
- `docs/guides/releasing.md`
- `docs/features/cli-status/spec.md`
