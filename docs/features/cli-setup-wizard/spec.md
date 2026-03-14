# CLI Setup Wizard

## Overview
`iranti setup` is the first-run onboarding wizard for installed-package users. It guides a user through runtime installation, instance creation or update, provider credential entry, Iranti client API key generation, optional project bindings, and optional Claude Code / Codex integration scaffolding in one interactive flow.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--scope` | `user \| system` | Preferred install scope when using a shared runtime. |
| `--root` | `string` | Explicit runtime root. Required for deterministic isolated installs or custom shared locations. |
| `--defaults` | `boolean` | Runs setup non-interactively using defaults plus environment/flag input. |
| `--config` | `string` | Path to a JSON setup plan used for repeatable non-interactive bootstrap. |
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

## Decision Tree / Flow
1. Require a real terminal session.
2. Ask whether setup should use a shared runtime or an isolated runtime folder.
3. Resolve and create the runtime root.
4. Ask for the instance name.
5. Select an API port, warning if `3001` is occupied and suggesting the next free port.
6. Ask how PostgreSQL should be provided: existing, managed, or Docker-local.
7. When Docker-local is selected, optionally start or reuse a Docker PostgreSQL container and derive the connection string automatically.
8. Ask for the default LLM provider.
9. If the provider is remote, require its API key.
10. Offer to collect additional provider keys for other supported providers.
11. Generate or rotate a usable instance `IRANTI_API_KEY` so the instance can run even without DB-backed registry setup.
12. Create or update the target instance env.
13. Optionally bootstrap the database schema and seed data.
14. Offer to bind one or more project folders by writing `.env.iranti`.
15. For each bound project, optionally scaffold Claude Code MCP and hook files.
16. If Codex is installed and at least one project was bound, optionally register Codex globally against the first bound project.
17. Print a runnable summary with next-step commands.

Non-interactive variants:
- `--defaults` derives values from flags and environment variables, but still requires a real `DATABASE_URL`.
- `--config <file>` reads a JSON plan and executes the same runtime/instance/project binding flow without prompts.
- `--bootstrap-db` can be used with automated setup to run migrations and seeding immediately after instance configuration.

## Edge Cases
- If the user enters a placeholder database URL, the wizard keeps prompting instead of exiting half-configured.
- Existing instances are updated in place instead of failing on name collision.
- `mock` and `ollama` are valid providers but do not prompt for remote provider keys.
- Unsupported providers such as Perplexity are shown as unavailable instead of being silently accepted.
- The wizard can finish without a live DB-backed API key registry because it writes a usable legacy `IRANTI_API_KEY` into the instance env.
- Existing `.mcp.json` or `.claude/settings.local.json` files are left untouched; scaffolding only fills missing files.
- `--defaults` fails fast if no real database URL is available rather than creating a fake finished setup.
- Docker is optional and only used when the user explicitly chooses a Docker-hosted PostgreSQL path.
- `--bootstrap-db` requires a fresh or already-compatible pgvector-capable PostgreSQL database. If the target DB is populated but not Prisma-baselined, or pgvector is unavailable, setup stops with actionable guidance instead of a generic failure.

## Test Results
- `npm run build` completed successfully after wiring the wizard into the CLI.
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
