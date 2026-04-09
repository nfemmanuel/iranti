# GitHub Copilot Guide

Use Iranti with GitHub Copilot through:
- `iranti copilot-setup` for global and workspace MCP registration
- `iranti integrate copilot` as an alias for the same setup flow
- `iranti mcp` as the actual MCP server command used by Copilot

This guide is written for the installed-package path, not for running Iranti out of a source checkout.

For shared "RAM-like" project memory, do not rely only on retrieval plus occasional writes.
The strong pattern for Copilot is:
- `iranti_handshake` at session start
- `iranti_attend` before each reply
- `iranti_checkpoint` at meaningful milestones while work is in flight
- `iranti_remember_response` when your final answer contains a strict durable summary

## Prerequisites

- `npm install -g iranti`
- GitHub Copilot CLI or VS Code with Copilot Chat
- a running Iranti instance, for example `iranti run --instance local`
- a project binding created with `iranti project init`

Example project binding:

```bash
cd /path/to/your/project
iranti project init . --instance local --agent-id copilot_code
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

## 2. Register Iranti with Copilot

Run once on the machine:

```bash
iranti copilot-setup
```

Equivalent alias:

```bash
iranti integrate copilot
```

What it does:
- writes a global Copilot MCP config entry to `~/.copilot/mcp-config.json`
- prefers the installed CLI path: `iranti mcp`
- when run from a bound project, writes or merges project-local `.mcp.json` and `.vscode/mcp.json` entries pinned to that binding
- writes `.github/copilot-instructions.md` with the full Iranti per-turn protocol
- writes `IRANTI.md` with the canonical memory protocol reference
- writes `.github/hooks/hooks.json` with a `userPromptSubmitted` hook that fires a protocol reminder before every Copilot turn
- writes `.github/hooks/iranti-protocol-hook.js` — the hook script itself
- does not pin `IRANTI_PROJECT_ENV` unless you explicitly pass `--project-env`
- merges into any existing MCP config without removing other servers

Optional overrides:

```bash
iranti copilot-setup --name iranti --agent copilot_code --source Copilot --provider openai --project-env C:/path/to/project/.env.iranti
```

Use `--project-env` only when you deliberately want the global Copilot MCP registration pinned to one project binding.

Use `--local-script` only if you need to point Copilot at this repo build directly.

Use `--no-workspace-file` only if you explicitly want global registration without project-local MCP file updates.

## 3. Verify the setup

Check that the workspace files were created:

```bash
cat .mcp.json
cat .vscode/mcp.json
cat .github/copilot-instructions.md
cat .github/hooks/hooks.json
```

The project-local `.mcp.json` should contain:
- command: `iranti`
- args: `mcp`
- env:
  - `IRANTI_PROJECT_ENV=<absolute path to .env.iranti>`
  - `IRANTI_MCP_DEFAULT_AGENT=copilot_code`
  - `IRANTI_MCP_DEFAULT_SOURCE=Copilot`
  - `IRANTI_MCP_HOST=copilot_cli`

The VS Code-native `.vscode/mcp.json` should contain:
- `servers.iranti.type = stdio`
- command: `iranti`
- args: `mcp`
- `envFile = ${workspaceFolder}/.env.iranti` when the binding lives in the workspace root
- the default agent/source env values
- `IRANTI_MCP_HOST=copilot_vscode`

The `.github/hooks/hooks.json` should contain:
- `version: 1`
- `hooks.userPromptSubmitted` array with a command entry invoking `node .github/hooks/iranti-protocol-hook.js`

If you launch `iranti mcp` directly in a terminal, it will stay running and wait for a stdio MCP client. That is expected behavior, not a normal shell command completion.

Why multiple files:
- `~/.copilot/mcp-config.json` is the global Copilot MCP registry
- `.mcp.json` is for repo-local MCP conventions and other clients
- `.vscode/mcp.json` is what VS Code Copilot sessions read for workspace MCP configuration
- `.github/copilot-instructions.md` injects the Iranti protocol into every Copilot prompt (Copilot has no dynamic per-turn hook, so the protocol lives in static instructions)
- `.github/hooks/hooks.json` fires the protocol reminder hook on `userPromptSubmitted`

## 4. Host identities

Copilot setup uses two host identities depending on context:
- `copilot_cli` — when running Copilot from the CLI
- `copilot_vscode` — when running Copilot in VS Code

The default agent is `copilot_code` and the default source is `Copilot`. Override these with `--agent` and `--source` if needed.

## 5. Launch Copilot in the bound project

Open VS Code in the project that contains `.env.iranti`, or use Copilot CLI from that directory.

`iranti mcp` resolves the project binding from `IRANTI_PROJECT_ENV` first when explicitly pinned, and otherwise falls back to the current working directory.

## 6. Verification

Inside Copilot Chat, test:

1. `What MCP tools are available?`
2. `Use iranti_write to store that project/game_night_app has key snack_plan with value {"decision":"chips and sparkling water"} and summary Game night snack plan is chips and sparkling water.`
3. `Use iranti_query to fetch project/game_night_app key snack_plan.`

Important:
- Protected Staff Namespace entries such as `system/library/schema_version` are intentionally hidden from regular agent queries.
- If you want to test retrieval, use a non-protected project/user/entity fact instead.

## 7. Recommended usage policy

Use the integration like this:

- `iranti_handshake` at session start when the host supports it
- if the host has no startup hook, `iranti_handshake` on the first user turn before doing recall-sensitive work
- treat recall prompts such as `what is my favorite ...`, `what is the next step`, `what did we decide`, and `what is the blocker` as mandatory Iranti turns
- `iranti_attend` before every reply generation, not only when recall feels likely
- `iranti_checkpoint` whenever the task reaches a meaningful milestone, handoff point, or resumable breakpoint
- `iranti_query` when you know the exact entity and key
- `iranti_history` when you know the exact entity and key and need the full version history
- `iranti_search` when you need discovery
- `iranti_remember_response` when your own final answer contains a strict durable summary worth persisting
- `iranti_write` only for durable facts
- `iranti_ingest` only for stable content worth chunking

Do not auto-save every turn. That degrades retrieval quality quickly.

If Copilot is receiving work from Claude Code or Codex, treat the handoff as shared durable memory, not as session recovery. Read the shared `task/...` facts with `query()` or `attend()` plus explicit `entityHints`, then write your pickup/progress back to the same task entity.

## 8. Troubleshooting

If Copilot does not surface Iranti tools:

1. Confirm the CLI commands exist:

```bash
iranti mcp --help
iranti copilot-setup --help
```

2. Confirm the workspace MCP files exist:

```bash
cat .mcp.json
cat .vscode/mcp.json
```

3. Confirm the project binding exists in the active project:

```bash
cat .env.iranti
```

4. Confirm the linked instance is healthy:

```bash
iranti doctor --instance local
```

5. Restart VS Code or the Copilot CLI session after changing MCP registrations.

6. If Copilot CLI works but Copilot in VS Code still cannot find Iranti tools:

```bash
iranti doctor
```

Doctor now warns when the project binding is present but `.vscode/mcp.json` is missing or does not expose `iranti`.

7. If the protocol reminder hook is not firing, check that `.github/hooks/hooks.json` exists and contains a valid `userPromptSubmitted` entry:

```bash
cat .github/hooks/hooks.json
```

The hook fires `node .github/hooks/iranti-protocol-hook.js` — confirm that file exists and is valid JavaScript.

## Related

- `scripts/copilot-setup.ts`
- `scripts/iranti-cli.ts`
- `scripts/iranti-mcp.ts`
- `src/lib/runtimeEnv.ts`
- `docs/guides/cross-tool-handoffs.md`
