# Codex Guide

Use Iranti with Codex through:
- `iranti codex-setup` for global Codex MCP registration
- `iranti integrate codex` as an alias for the same setup flow
- `iranti mcp` as the actual MCP server command used by Codex

This guide is written for the installed-package path, not for running Iranti out of a source checkout.

## Prerequisites

- `npm install -g iranti`
- Codex CLI installed and on `PATH`
- a running Iranti instance, for example `iranti run --instance local`
- a project binding created with `iranti project init`

Example project binding:

```bash
cd /path/to/your/project
iranti project init . --instance local --agent-id codex_code_main
```

That writes `.env.iranti` with:
- `IRANTI_URL`
- `IRANTI_API_KEY`
- `IRANTI_AGENT_ID`
- `IRANTI_INSTANCE_ENV`

`iranti mcp` automatically loads `.env.iranti` from the active project directory and then loads the linked instance env to recover:
- `DATABASE_URL`
- `LLM_PROVIDER`
- upstream provider API keys

## 1. Start the Iranti API instance

In one terminal:

```bash
iranti run --instance local
```

## 2. Register Iranti with Codex globally

Run once on the machine:

```bash
iranti codex-setup
```

Equivalent alias:

```bash
iranti integrate codex
```

What it does:
- verifies `codex` is installed
- on Windows, resolves Codex through a concrete CLI target such as a bundled `codex.exe` or the npm-installed Codex package entrypoint instead of relying on PowerShell-only shim resolution
- replaces any existing MCP entry named `iranti`
- registers the global installed CLI path `iranti mcp`
- when run from a bound project, writes or merges a project-local `.mcp.json` pinned to that project's `.env.iranti`
- stores only safe defaults like default agent/source in Codex config
- does not pin `IRANTI_PROJECT_ENV` unless you explicitly pass `--project-env`

Optional overrides:

```bash
iranti codex-setup --name iranti --agent codex_code_main --source Codex --provider openai --project-env C:/path/to/project/.env.iranti
```

Use `--project-env` only when you deliberately want the global Codex MCP registration pinned to one project binding.

Use `--local-script` only if you deliberately want Codex bound to a repo checkout build instead of the installed package.

Use `--no-workspace-file` only if you explicitly want the global Codex registration without touching the current project's `.mcp.json`.

## 3. Verify the MCP registration

```bash
codex mcp list
codex mcp get iranti
```

You want the registration to show:
- command: `iranti`
- args: `mcp`
- env: includes safe defaults such as agent/source
- `IRANTI_PROJECT_ENV` only when you explicitly pinned a project with `--project-env`

If setup ran from a bound project, you also want the workspace file to exist:

```bash
type .mcp.json
```

The project-local `.mcp.json` should contain:
- command: `iranti`
- args: `mcp`
- env:
  - `IRANTI_PROJECT_ENV=<absolute path to .env.iranti>`
  - `IRANTI_MCP_DEFAULT_AGENT=<agent>`
  - `IRANTI_MCP_DEFAULT_SOURCE=<source>`

Optional opt-in memory capture:
- add `IRANTI_AUTO_REMEMBER=true` to the bound project's `.env.iranti`, or run `iranti configure project . --auto-remember true`
- this lets the `iranti_attend` tool persist only narrow explicit prompt facts before retrieval
- personal facts route to `IRANTI_PERSONAL_MEMORY_ENTITY` and default to `user/main`
- project facts route to `IRANTI_MEMORY_ENTITY`
- examples:
  - `my favorite snack is plantain chips`
  - `my home city is Lagos`
  - `we decided to ship the patch release first`
  - `the next step is rerun the db validation`

## 4. Launch Codex in the bound project

Open Codex in the project that contains `.env.iranti`:

```bash
codex -C /path/to/your/project
```

This matters because `iranti mcp` resolves the project binding from `IRANTI_PROJECT_ENV` first when explicitly pinned, and otherwise falls back to the current working directory.

## 5. Verification

Inside Codex, test:

1. `What MCP tools are available?`
2. `Use iranti_write to store that project/game_night_app has key snack_plan with value {"decision":"chips and sparkling water"} and summary Game night snack plan is chips and sparkling water.`
3. `Use iranti_query to fetch project/game_night_app key snack_plan.`

Important:
- Protected Staff Namespace entries such as `system/library/schema_version` are intentionally hidden from regular agent queries.
- If you want to test retrieval, use a non-protected project/user/entity fact instead.

## 6. Recommended usage policy

Use the integration like this:

- `iranti_query` when you know the exact entity and key
- `iranti_search` when you need discovery
- `iranti_write` only for durable facts
- `iranti_ingest` only for stable content worth chunking

Do not auto-save every turn. That degrades retrieval quality quickly.
If you enable `IRANTI_AUTO_REMEMBER=true`, treat it as a narrow convenience path for explicit prompt facts only, not a replacement for `iranti_write`.

If Codex is receiving work from Claude Code, treat the handoff as shared durable memory, not as Claude session recovery. Read the shared `task/...` facts with `query()` or `attend()` plus explicit `entityHints`, then write your pickup/progress back to the same task entity.

## 7. Troubleshooting

If Codex does not surface Iranti tools:

1. Confirm the CLI commands exist:

```bash
iranti mcp --help
iranti codex-setup --help
```

If `iranti codex-setup` says `codex` is not installed or not on `PATH`, fix that first:

```bash
codex --version
```

On Windows, if `codex --version` works in PowerShell but `iranti codex-setup` still cannot find Codex, point Iranti at the concrete Codex CLI path and rerun setup:

```powershell
$env:CODEX_CLI_PATH = "C:\path\to\codex.exe"
iranti codex-setup
```

Use a direct executable path when possible. If your install comes from global npm shims, `CODEX_CLI_PATH` may also point at the npm-installed `codex.cmd` path and Iranti will resolve the underlying Codex package entrypoint.

2. Confirm the global MCP registration exists:

```bash
codex mcp list
codex mcp get iranti
```

3. Confirm the project binding exists in the active project:

```bash
type .env.iranti
```

4. Confirm the linked instance is healthy:

```bash
iranti doctor --instance local
```

5. Restart the Codex app or CLI session after changing MCP registrations.

## Related

- `scripts/codex-setup.ts`
- `scripts/iranti-cli.ts`
- `scripts/iranti-mcp.ts`
- `src/lib/runtimeEnv.ts`
- `docs/features/codex-mcp/spec.md`
- `docs/guides/cross-tool-handoffs.md`
