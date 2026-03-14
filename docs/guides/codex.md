# Codex Guide

Use Iranti with Codex through:
- `iranti codex-setup` for global Codex MCP registration
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

What it does:
- verifies `codex` is installed
- replaces any existing MCP entry named `iranti`
- registers the global installed CLI path `iranti mcp`
- if `.env.iranti` exists in the current working directory, stores it as `IRANTI_PROJECT_ENV`
- stores only safe defaults like default agent/source in Codex config

Optional overrides:

```bash
iranti codex-setup --name iranti --agent codex_code_main --source Codex --provider openai --project-env C:/path/to/project/.env.iranti
```

Use `--local-script` only if you deliberately want Codex bound to a repo checkout build instead of the installed package.

## 3. Verify the MCP registration

```bash
codex mcp list
codex mcp get iranti
```

You want the registration to show:
- command: `iranti`
- args: `mcp`
- env: includes `IRANTI_PROJECT_ENV` when the project binding was detected or specified

## 4. Launch Codex in the bound project

Open Codex in the project that contains `.env.iranti`:

```bash
codex -C /path/to/your/project
```

This matters because `iranti mcp` resolves the project binding from `IRANTI_PROJECT_ENV` first, then falls back to the current working directory.

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

## 7. Troubleshooting

If Codex does not surface Iranti tools:

1. Confirm the CLI commands exist:

```bash
iranti mcp --help
iranti codex-setup --help
```

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
