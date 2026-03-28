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
- when run from a bound project, writes or merges a project-local `.mcp.json` and `.vscode/mcp.json` pinned to that project's `.env.iranti`
- stores only safe defaults like default agent/source in Codex config
- does not pin `IRANTI_PROJECT_ENV` unless you explicitly pass `--project-env`

Optional overrides:

```bash
iranti codex-setup --name iranti --agent codex_code_main --source Codex --provider openai --project-env C:/path/to/project/.env.iranti
```

Use `--project-env` only when you deliberately want the global Codex MCP registration pinned to one project binding.

Use `--local-script` only if you deliberately want Codex bound to a repo checkout build instead of the installed package.

Use `--no-workspace-file` only if you explicitly want the global Codex registration without touching the current project's MCP files.

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

If setup ran from a bound project, you also want the workspace files to exist:

```bash
type .mcp.json
type .vscode\mcp.json
```

The project-local `.mcp.json` should contain:
- command: `iranti`
- args: `mcp`
- env:
  - `IRANTI_PROJECT_ENV=<absolute path to .env.iranti>`
  - `IRANTI_MCP_DEFAULT_AGENT=<agent>`
  - `IRANTI_MCP_DEFAULT_SOURCE=<source>`

The VS Code-native `.vscode/mcp.json` should contain:
- `servers.iranti.type = stdio`
- command: `iranti`
- args: `mcp`
- `envFile = ${workspaceFolder}/.env.iranti` when the binding lives in the workspace root
- the default agent/source env values

If you launch `iranti mcp` directly in a terminal, it will stay running and wait for a stdio MCP client. That is expected behavior, not a normal shell command completion.

Why both files exist:
- Codex CLI reads its own global MCP registration from `~/.codex/config.toml`
- VS Code MCP clients, including Codex VS Code sessions, look for workspace MCP configuration in `.vscode/mcp.json`
- `.mcp.json` remains useful for repo-local MCP conventions and other clients, but it is not sufficient by itself for VS Code Codex sessions

Optional opt-in memory capture:
- add `IRANTI_AUTO_REMEMBER=true` to the bound project's `.env.iranti`, or run `iranti configure project . --auto-remember true`
- this lets the `iranti_attend` tool persist only narrow explicit prompt facts before retrieval
- personal facts route to `IRANTI_PERSONAL_MEMORY_ENTITY` and default to `user/main`
- project facts route to `IRANTI_MEMORY_ENTITY`
- prompt-captured personal facts are stored as direct user memory so later explicit user corrections can replace older hook-written values
- examples:
  - `my favorite snack is plantain chips`
  - `my home city is Lagos`
  - `we decided to ship the patch release first`
  - `the next step is rerun the db validation`

Codex does not have the Claude `Stop` hook path. If Codex itself is about to say a durable structured summary, use:
- `iranti_remember_response`

Good uses:
- `The next step is rerun the db validation.`
- `The blocker is missing provider credentials.`
- `We decided to ship the patch release first.`
- `The current owner is codex_code_main.`

If Codex needs to pin the target explicitly instead of relying on the bound project defaults, pass `projectEntity` or `personalEntity` to `iranti_remember_response`.

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

- treat recall prompts such as `what is my favorite ...`, `what is the next step`, `what did we decide`, and `what is the blocker` as mandatory Iranti turns
- `iranti_query` when you know the exact entity and key
- `iranti_search` when you need discovery
- `iranti_attend` before answers that depend on remembered state
- `iranti_remember_response` when your own final answer contains a strict durable summary worth persisting
- `iranti_write` only for durable facts
- `iranti_ingest` only for stable content worth chunking

Do not auto-save every turn. That degrades retrieval quality quickly.
If you enable `IRANTI_AUTO_REMEMBER=true`, treat it as a narrow convenience path for explicit prompt facts only, not a replacement for `iranti_write`.
`iranti_remember_response` is the explicit Codex-side equivalent for strict post-response summaries; it is still intentionally narrow and should not be used for arbitrary prose.

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

6. If Codex CLI works but Codex VS Code still says `iranti_query` or `iranti_attend` is not available:

```bash
iranti doctor
```

Doctor now warns when the project binding is present but `.vscode/mcp.json` is missing or does not expose `iranti`.

## Related

- `scripts/codex-setup.ts`
- `scripts/iranti-cli.ts`
- `scripts/iranti-mcp.ts`
- `src/lib/runtimeEnv.ts`
- `docs/features/codex-mcp/spec.md`
- `docs/guides/cross-tool-handoffs.md`
