# Compatibility Contracts

## Overview

Compatibility contracts define which Iranti surfaces are considered stable within a major version, how additive change is distinguished from breaking change, and what deprecation and migration behavior is required before retiring an existing surface. The feature exists to keep upgrades trustworthy across the CLI, REST API, published clients, config files, runtime metadata, and persisted state.

## Inputs

| Input | Type | Description |
|---|---|---|
| Surface type | enum | One of `cli`, `api`, `sdk`, `config`, `runtime_metadata`, `database`, `docs`, `tests`. |
| Proposed change | object | Description of a new field, route, command, flag, schema change, response-shape change, or removal. |
| Release target | enum | One of `patch`, `minor`, `major`. |
| Existing contract | object | Current documented behavior, response shape, flag semantics, config keys, or migration expectations. |
| Compatibility evidence | object | Tests, migration checks, release-note entries, fallback parsing, warning output, or benchmark results showing the change is safe. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Compatibility decision | enum | `compatible`, `compatible_with_deprecation`, `major_only`, or `blocked`. |
| Required actions | string[] | Concrete work required before the change is acceptable, such as adding tests, warnings, migration shims, or docs. |
| Release note requirements | string[] | What must be called out in changelog or migration notes. |
| Test obligations | string[] | Required contract, migration, or upgrade tests before release. |

## Decision Tree / Flow

1. Identify the surface being changed.
2. Determine whether the change is additive, behavioral, or removal/rename.
3. Classify the release target:
   - `patch` must preserve existing user flows and current integrations.
   - `minor` may add surfaces and deprecations, but should preserve current integrations.
   - `major` is the boundary for deliberate contract reshaping.
4. For the affected surface, apply the contract rules:
   - CLI:
     - Existing commands and flags are compatibility surfaces.
     - New commands should be additive, documented in the guides, and covered by at least one contract or drift check.
     - Human-readable output may improve.
     - `--json` output is automation-facing and should remain stable within the same major version.
   - REST API:
     - Existing routes and existing required response fields are compatibility surfaces.
     - Additive fields are allowed if old clients still parse successfully.
   - SDKs:
     - Existing public method names, parameter semantics, and core result shapes are compatibility surfaces.
     - Additive optional parameters or fields are preferred.
   - Config and runtime metadata:
     - Existing keys and file formats must continue to load or receive compatibility parsing.
     - Missing new fields must get safe defaults.
   - Database and durable state:
     - Existing installs must migrate without data loss.
     - Durable state should be migrated, not silently reinterpreted.
5. Decide whether the proposed change is:
   - `compatible`
   - `compatible_with_deprecation`
   - `major_only`
   - `blocked`
6. If deprecation is required, add:
   - a warning path
   - replacement guidance
   - migration notes
   - at least one documented release cycle before removal when feasible
7. Add or update compatibility evidence:
   - contract tests
   - config loading tests
   - runtime metadata parsing tests
   - upgrade/restart tests
   - client/server compatibility checks where practical
8. Update docs:
   - ADR if policy changed
   - feature spec if contract rules changed
   - README or quickstart if public behavior changed
   - changelog or migration notes when deprecations or compatibility shims are introduced

## Edge Cases

- Debug-only API fields may evolve faster, but their meaning should not silently change without documentation.
- Security fixes may require faster removal or tighter behavior changes than the normal deprecation cycle; if so, the reason must be documented explicitly.
- A config key may be replaced by a new key only if fallback parsing or migration guidance exists for older installs.
- A route may add new optional fields, but old clients must not fail parsing because of the addition.
- Runtime metadata readers must tolerate older `runtime.json` shapes with missing fields.
- `iranti status --json` is an automation-facing CLI surface; additive fields are allowed, but existing fields and meanings should remain stable within the major version.
- `GET /memory/sessions` and client session-list helpers are automation-facing operator surfaces; additive query options are allowed, but existing summary fields and operator-state semantics should remain stable within the major version.
- Upgrade commands must distinguish between install version and running instance version so mixed-version state is visible and recoverable.

## Test Results

- Policy-level documentation feature; no runtime behavior changed in this spec-only pass.
- Existing supporting checks already in the repo include:
  - `scripts/test-contracts.ts` for API and client contract drift
  - `tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts` for runtime metadata and restart behavior
  - `tests/session-recovery/run_session_recovery_tests.ts` for durable recovery behavior
- Follow-on implementation work is tracked in [docs/internal/compatibility_backlog.md](../../internal/compatibility_backlog.md).

## Related

- [007 - Compatibility Policy](../../decisions/007-compatibility-policy.md)
- [Runtime Upgrades](../runtime-upgrades/spec.md)
- [Interrupted Session Recovery](../interrupted-session-recovery/spec.md)
- [docs/internal/compatibility_backlog.md](../../internal/compatibility_backlog.md)
- [scripts/test-contracts.ts](../../../scripts/test-contracts.ts)
- [tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts](../../../tests/runtime-lifecycle/run_runtime_lifecycle_tests.ts)
