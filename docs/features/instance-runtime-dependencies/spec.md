# Instance Runtime Dependencies

## Overview

Iranti instances can depend on external services such as PostgreSQL containers.
Before this feature, `iranti run --instance <name>` and `iranti instance restart <name>`
only started the Iranti API process. If the backing Docker container was stopped,
the API could appear healthy at `/health` while exact KB operations failed at runtime.

This feature adds explicit per-instance dependency metadata in `instance.json`
and a pre-start dependency check so `run` can bring those dependencies up first.

## Inputs

| Input | Type | Description |
|---|---|---|
| `instance.json.dependencies` | array | Optional dependency metadata owned by one instance. |
| `docker-container` dependency | object | Docker container name plus optional host TCP port to wait on. |
| `iranti setup --db-mode docker` | command | Now records the created/reused Docker PostgreSQL container as an instance dependency. |
| `iranti configure instance <name> --docker-container <name>` | command | Records or updates one Docker container dependency for an existing instance. |
| `iranti configure instance <name> --docker-health-port <n>` | command | Records the host TCP port to wait on before starting the API. |
| `iranti configure instance <name> --clear-docker-container` | command | Removes the recorded Docker container dependency. |
| `iranti run --instance <name>` | command | Ensures recorded dependencies are running before the API boots. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Updated `instance.json` | file | Stores explicit dependency metadata for the instance. |
| `iranti instance show` output | text | Includes dependency summary when present. |
| `iranti run --instance` output | text | Reports whether dependency containers were started or already running. |

## Dependency Metadata

First slice supports:

```json
{
  "dependencies": [
    {
      "kind": "docker-container",
      "name": "iranti_dev_db",
      "healthTcpPort": 5434
    }
  ]
}
```

## Decision Tree / Flow

1. Read instance metadata from `instance.json`.
2. Parse `dependencies` and reject invalid metadata as an invalid instance config.
3. When setup uses `--db-mode docker`, record the Docker PostgreSQL container and host port as a dependency.
4. When `configure instance` is called with Docker dependency flags, rewrite `instance.json` and preserve unrelated instance metadata.
5. On `iranti run --instance <name>`:
   - validate env and runtime metadata as before
   - if dependencies are recorded, ensure each dependency is running
   - for Docker container dependencies:
     - require Docker CLI on PATH
     - require Docker daemon reachability
     - require the named container to already exist
     - start the container if it is stopped
     - optionally wait for the declared host TCP port
   - once dependencies are ready, start the Iranti API process
6. `iranti instance restart` continues to restart through `run`, so dependency startup is inherited automatically.

## Edge Cases

- If Docker is not installed, `run` fails clearly instead of booting Iranti against a dead dependency.
- If Docker daemon is down, `run` fails clearly instead of leaving the user with a half-live API.
- If the named dependency container does not exist, `run` fails and tells the operator which container is missing.
- If the dependency host port never becomes reachable, `run` fails before starting the API.
- Instances without dependency metadata behave exactly as before.
- First slice only supports `docker-container` dependencies. Compose stacks and non-Docker dependencies are deferred.

## Deferred

- `docker-compose` / `docker compose` project dependencies
- automatic dependency inference from `DATABASE_URL`
- status/doctor health correlation that explicitly reports “API up, DB dependency down”
- vector-backend dependency startup

## Test Results

- `npm run test:instance-dependencies`
- `npm run build`

## Related

- `scripts/iranti-cli.ts`
- `src/lib/runtimeDependencies.ts`
- `docs/features/cli-configure/spec.md`
- `tests/runtime-lifecycle/run_instance_dependency_tests.ts`
