# Instance Database Intent

## Overview

Iranti now stores explicit per-instance database intent in `instance.json`.
This removes a class of repair ambiguity where Iranti could see a dead
`DATABASE_URL` but could not safely know whether that target was supposed to be:

- a dedicated per-instance local database
- a shared local database reused by multiple instances
- a fully external existing database that should never be recreated locally

This first slice adds metadata and CLI surfaces so setup, configure, and future
repair flows can stop guessing.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--db-intent` | `dedicated \| shared \| external` | Optional explicit database strategy for setup/configure flows. |
| `instance.json.databaseIntent` | object | Persisted per-instance DB strategy and target metadata. |
| `DATABASE_URL` | string | Source of host/port/database target details. |
| `instance.json.dependencies` | array | Used to distinguish Docker-local from other local provisioning paths. |

## Stored Metadata

```json
{
  "databaseIntent": {
    "strategy": "dedicated-local",
    "provisioning": "docker",
    "host": "localhost",
    "port": 5434,
    "database": "iranti_local",
    "dockerContainerName": "iranti_local_db"
  }
}
```

Strategies:

- `dedicated-local`
- `shared-local`
- `external-existing`

Provisioning remains:

- `local`
- `docker`
- `managed`

## Decision Tree / Flow

1. During `iranti setup`, resolve `DATABASE_URL` and DB mode as before.
2. If `--db-intent` or setup-config `databaseIntent` is provided, normalize it.
3. Otherwise infer a safe default:
   - `managed` => `external-existing`
   - local/docker with DB name `iranti_<instance>` => `dedicated-local`
   - other local/docker DB names => `shared-local`
4. Persist that metadata into `instance.json`.
5. During `iranti configure instance`, allow the operator to change the explicit DB intent.
6. When `instance show` runs:
   - prefer explicit `databaseIntent` from metadata
   - if missing, infer it from the current env and dependency state
   - label inferred state as inferred rather than pretending it was explicit
7. Invalid `databaseIntent` metadata marks the instance config as invalid so repair can correct it instead of silently proceeding with bad metadata.

## Edge Cases

- Existing instances without `databaseIntent` remain valid. `instance show` infers a best-effort strategy without mutating files.
- `iranti instance create` now refuses sibling names that normalize to the same identity after hyphen/underscore folding (for example `mini_app_olis` vs `mini-app-olis`). This prevents two instances from silently targeting the same default database slug or looking interchangeable in Control Plane.
- `--db-intent external` may still point at localhost if the operator explicitly wants Iranti to treat that DB as externally managed.
- Docker-backed local DBs can still be marked `shared-local` when one container/DB is intentionally shared.
- Metadata does not yet fingerprint a specific PostgreSQL server identity; this slice is about intent and target shape, not cryptographic origin validation.

## Test Results

- `npx ts-node tests/runtime-lifecycle/run_instance_dependency_tests.ts`
- `npm run build`

## Related

- `scripts/iranti-cli.ts`
- `docs/features/cli-setup-wizard/spec.md`
- `docs/features/cli-configure/spec.md`
- `docs/features/instance-runtime-dependencies/spec.md`
