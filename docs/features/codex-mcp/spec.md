# Codex MCP Integration

## Overview

This feature connects Codex to Iranti through Codex's MCP client and this repository's `AGENTS.md`. It provides a repeatable setup path for registering the Iranti MCP server globally in Codex, while keeping repository-specific behavior in source-controlled documentation and instructions.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--name` | string | MCP server name to register in Codex. Defaults to `iranti`. |
| `--agent` | string | Default Iranti agent id for Codex sessions. Defaults to `codex_code`. |
| `--source` | string | Default provenance label used for writes through MCP. Defaults to `Codex`. |
| `--provider` | string | Optional `LLM_PROVIDER` override passed to the MCP process. |
| `.env` | file | Repository-local environment file containing `DATABASE_URL` and optional Iranti settings. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Codex MCP registration | global config entry | A registered MCP server in Codex pointing at `dist/scripts/iranti-mcp.js`. |
| `codex mcp get iranti` | CLI output | Verification of the stored Codex MCP configuration. |
| `npm run codex:run` | CLI command | Launches Codex with this repository as the working root so `AGENTS.md` applies. |

## Decision Tree / Flow

1. Build the repo so `dist/scripts/iranti-mcp.js` exists.
2. Run `npm run codex:setup`.
3. The setup script verifies `codex` is installed.
4. If a Codex MCP entry with the target name already exists, remove it.
5. Register a new global Codex MCP entry using `codex mcp add`.
6. Store only safe defaults like default agent/source in the MCP entry.
7. At runtime, `iranti-mcp` loads `.env` from the repo and opens the Iranti SDK/API path.
8. Launch Codex with `codex -C .` so repo-local `AGENTS.md` instructions are active.

## Edge Cases

- If `codex` is not installed, setup fails fast with a direct error.
- If `dist/scripts/iranti-mcp.js` is missing, setup fails and instructs the user to run `npm run build`.
- If a prior MCP entry exists, setup replaces it so reruns are deterministic.
- `DATABASE_URL` is not written into Codex config; the MCP process resolves `.env` at runtime instead.
- If the repo `.env` is missing or invalid, MCP startup fails when Codex tries to connect.

## Test Results

- `npm run build` passes with the new Codex setup script included.
- `npm run codex:setup` successfully registers `iranti` in Codex MCP config.
- `codex mcp get iranti` returns the expected command-based MCP entry.

## Related

- `scripts/codex-setup.ts`
- `scripts/iranti-mcp.ts`
- `docs/guides/codex.md`
- `docs/guides/claude-code.md`
