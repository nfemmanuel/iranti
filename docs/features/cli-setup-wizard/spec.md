# CLI Setup Wizard

## Overview
`iranti setup` is the first-run onboarding wizard for installed-package users. It guides a user through runtime installation, instance creation or update, provider credential entry, Iranti client API key generation, optional project bindings, and optional Claude Code / Codex integration scaffolding in one interactive flow.
The interactive wizard also explains high-friction choices inline before prompting, especially around isolated vs shared mode, runtime-root selection, database sourcing, provider choice, project binding, and Codex registration.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--scope` | `user \| system` | Preferred install scope when using a shared runtime. |
| `--root` | `string` | Explicit runtime root. Required for deterministic isolated installs or custom shared locations. |
| `--mode` | `isolated \| shared` | Chooses whether setup should default to one project per instance or a shared machine-level instance. Default is `isolated`. |
| `--defaults` | `boolean` | Runs setup non-interactively using defaults plus environment/flag input. |
| `--config` | `string` | Path to a JSON setup plan used for repeatable non-interactive bootstrap. |
| `--db-mode` | `local \| managed \| docker` | Selects how PostgreSQL should be sourced during automated setup. |
| `--auto-remember` | `boolean \| string` | Writes `IRANTI_AUTO_REMEMBER` into each generated project binding. Bare flag means `true`. |
| `--bootstrap-db` | `boolean` | Runs migrations and seeding after non-interactive setup when the database is reachable. |
| terminal answers | interactive text | User-provided answers for runtime mode, instance name, database URL, providers, secrets, and project paths. |

## Outputs

| Output | Type | Description |
|---|---|---|
| runtime install | filesystem | Creates runtime folders and `install.json` under the selected root. |
| instance env | filesystem | Creates or updates the target instance `.env` with database, provider, provider keys, and `IRANTI_API_KEY`. |
| project bindings | filesystem | Writes `.env.iranti` into selected project folders. |
| Claude Code config | filesystem | Optionally creates `.mcp.json` and `.claude/settings.local.json` in bound projects. |
| Codex registration | external config | Optionally registers the first bound project with Codex MCP through `codex-setup`. |
| dependency preflight | text | Reports whether Docker, `psql`, `pg_isready`, and a local PostgreSQL listener on `localhost:5432` are detected before deeper setup continues. |

## Decision Tree / Flow
1. Report a dependency preflight for Docker, `psql`, `pg_isready`, and `localhost:5432`.
2. Require a real terminal session.
3. Ask whether setup should use an isolated per-project runtime folder or a shared machine-level runtime. Default to `isolated`.
   - Before prompting, explain what `isolated` and `shared` mean and when each should be used.
4. Resolve and create the runtime root.
   - In isolated mode, explain that the chosen path becomes the runtime root storing instances, metadata, and logs for that isolated setup.
   - In shared mode, explain `user` vs `system` scope and when an explicit `--root` is preferable.
5. Ask for the instance name.
6. Select an API port, warning if `3001` is occupied and suggesting the next free port.
7. Recommend a PostgreSQL source in this order: local, Docker, then managed.
8. Ask how PostgreSQL should be provided: local, managed, or Docker-local. Legacy `existing` remains accepted as an alias for `local`.
   - Before prompting, explain what each database mode means and when to choose it.
9. When Docker-local is selected, optionally start or reuse a Docker PostgreSQL container and derive the connection string automatically.
10. When local PostgreSQL is selected and `psql` is available, create the target localhost database automatically if it does not already exist.
11. Ask for the default LLM provider.
   - Before prompting, explain the difference between local/dev providers (`mock`, `ollama`) and remote providers that require API keys.
12. If the provider is remote, require its API key.
13. Offer to collect additional provider keys for other supported providers.
14. Generate or rotate a usable instance `IRANTI_API_KEY` so the instance can run even without DB-backed registry setup.
15. Create or update the target instance env.
16. Optionally bootstrap the database schema and seed data.
17. Offer to bind project folders by writing `.env.iranti`, tagging each binding with `IRANTI_PROJECT_MODE`.
   - Before prompting, explain that binding targets one specific repo/app root rather than a broad parent directory.
   - Ask whether strict auto-remember should be enabled for each project binding and write `IRANTI_AUTO_REMEMBER=true|false`.
18. In isolated mode, allow one bound project. Shared mode may bind multiple projects.
19. For each bound project, optionally scaffold Claude Code MCP and hook files.
20. If Codex is installed and at least one project was bound, optionally register Codex globally against the first bound project.
   - Before prompting, explain that Codex registration touches the machine-global Codex MCP config.
21. Print a runnable summary with next-step commands.

Non-interactive variants:
- `--defaults` derives values from flags and environment variables. It synthesizes a localhost or Docker `DATABASE_URL` automatically for `local` and `docker` modes, but still requires a real `DATABASE_URL` for `managed`.
- `--defaults --auto-remember` writes `IRANTI_AUTO_REMEMBER=true` into each generated project binding. Omitting the flag writes `false`.
- generated project bindings also include `IRANTI_PERSONAL_MEMORY_ENTITY=user/main` unless a setup config overrides it per project.
- `--config <file>` reads a JSON plan and executes the same runtime/instance/project binding flow without prompts.
- `--bootstrap-db` can be used with automated setup to run migrations and seeding immediately after instance configuration.

## Edge Cases
- If the user enters a placeholder database URL, the wizard keeps prompting instead of exiting half-configured.
- Existing instances are updated in place instead of failing on name collision.
- Isolated mode only binds one project. Shared mode remains the explicit path for multi-project memory sharing.
- `mock` and `ollama` are valid providers but do not prompt for remote provider keys.
- Unsupported providers such as Perplexity are shown as unavailable instead of being silently accepted.
- The wizard can finish without a live DB-backed API key registry because it writes a usable legacy `IRANTI_API_KEY` into the instance env.
- Existing `.mcp.json` or `.claude/settings.local.json` files are left untouched; scaffolding only fills missing files.
- `--defaults` fails fast only for managed PostgreSQL without a real `DATABASE_URL`. Local and Docker modes derive a concrete URL automatically.
- Docker is optional and only used when the user explicitly chooses a Docker-hosted PostgreSQL path.
- Dependency preflight is advisory rather than blocking: setup continues even if Docker or PostgreSQL tooling is missing, because managed Postgres remains valid.
- Iranti still requires PostgreSQL. There is no SQLite or in-memory fallback backend in setup.
- Local database self-creation is limited to localhost URLs and requires `psql`.
- `--bootstrap-db` requires a fresh or already-compatible pgvector-capable PostgreSQL database. If the target DB is populated but not Prisma-baselined, or pgvector is unavailable, setup stops with actionable guidance instead of a generic failure.

## Test Results
- `npm run build` completed successfully after wiring the wizard into the CLI.
- `npx ts-node tests/runtime-lifecycle/run_setup_upgrade_tests.ts`
  - `setup --defaults` printed the dependency preflight before executing the setup plan
  - `install --root <path>` created the runtime root, `instances/`, and `install.json`
  - `setup --defaults` created install metadata, instance env, project binding, `.mcp.json`, and `.claude/settings.local.json`
  - repeating the same `setup --defaults` invocation updated the existing instance cleanly instead of failing on idempotent rerun
  - `setup --defaults --mode shared --projects <a>,<b>` bound multiple projects and tagged each binding `IRANTI_PROJECT_MODE=shared`
  - generated project bindings now include `IRANTI_PERSONAL_MEMORY_ENTITY=user/main` plus `IRANTI_AUTO_REMEMBER=true|false`, so personal memory and opt-in auto-remember can be decided during setup instead of by hand-editing `.env.iranti`
  - `status --json` classified the created instance as configured but not running
- `node dist/scripts/iranti-cli.js help` shows `iranti setup` in the machine-level command list.
- `node dist/scripts/iranti-cli.js setup --defaults --root tests/tmp_cli_setup_runtime --instance cli_setup_smoke --provider mock --db-url <db> --projects tests/tmp_cli_setup_project --claude-code` completed and wrote the instance env plus project binding files.
- `--bootstrap-db` was verified to fail fast with guidance when the target PostgreSQL instance was not suitable for Prisma bootstrap (for example missing `pgvector` or already-populated without baseline).
- Core setup subcomponents were smoke-tested through existing lower-level helpers:
  - runtime install
  - instance creation/update
  - provider-key add/update/remove
  - project binding writes

## Related
- [`scripts/iranti-cli.ts`](C:\Users\NF\Documents\Projects\iranti\scripts\iranti-cli.ts)
- [`docs/guides/quickstart.md`](C:\Users\NF\Documents\Projects\iranti\docs\guides\quickstart.md)
- [`iranti.setup.example.json`](C:\Users\NF\Documents\Projects\iranti\docs\guides\iranti.setup.example.json)
- [`README.md`](C:\Users\NF\Documents\Projects\iranti\README.md)
- [`docs/guides/claude-code.md`](C:\Users\NF\Documents\Projects\iranti\docs\guides\claude-code.md)
- [`docs/guides/codex.md`](C:\Users\NF\Documents\Projects\iranti\docs\guides\codex.md)
