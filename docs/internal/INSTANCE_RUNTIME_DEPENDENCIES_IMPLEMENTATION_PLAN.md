# Instance Runtime Dependencies Implementation Plan

## Goal

Make `iranti run --instance <name>` and `iranti instance restart <name>`
dependency-aware for explicitly Docker-backed instances, without guessing from
ambient machine state.

## Why

Current behavior can produce a misleading “live” API:

- Iranti API starts
- `/health` responds
- backing PostgreSQL container is stopped
- exact KB reads/writes fail with Prisma connection errors

That is operationally expensive and easy to misread.

## Product Standard

Dependency startup must be:

- explicit
- instance-owned
- deterministic
- bounded
- observable

Not:

- inferred from random Docker projects on the machine
- coupled to one-off shell habits
- hidden behind a vague health success

## First Slice

### Scope

Implement only `docker-container` dependencies.

### Deliverables

1. `instance.json.dependencies`
2. parser/validator for dependency metadata
3. setup persistence for `--db-mode docker`
4. configure-instance flags for existing instances
5. pre-start dependency enforcement in `iranti run --instance`
6. show-instance dependency visibility
7. focused regression coverage

### Non-goals

- docker compose orchestration
- arbitrary process dependencies
- automatic DB recovery when the container was deleted
- doctor/status dependency graph

## Data Model

```json
{
  "dependencies": [
    {
      "kind": "docker-container",
      "name": "iranti_dev_db",
      "healthTcpPort": 5434,
      "startTimeoutMs": 30000
    }
  ]
}
```

## CLI Changes

### Setup

When setup chooses Docker PostgreSQL:

- persist the container name
- persist the host port Iranti expects

### Configure

Add:

- `--docker-container <name>`
- `--docker-health-port <n>`
- `--clear-docker-container`

### Run

Before starting the API process:

1. read dependency metadata
2. ensure each dependency is present
3. start stopped containers
4. wait for declared host TCP ports
5. only then boot the API

## Test Strategy

### Direct helper tests

- valid dependency metadata parses
- invalid dependency metadata is rejected
- stopped fake Docker container is started
- missing fake Docker container fails clearly

### CLI smoke

- `configure instance` writes dependency metadata
- `instance show` prints dependency summary

## Next Slice

1. `docker compose` support with service selection
2. doctor/status surfacing of dependency health
3. optional dependency metadata in setup config files
4. memory/runtime tests across Claude CLI, Claude VS Code, Codex CLI, and Codex VS Code before release
