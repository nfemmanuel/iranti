# Codex MCP Integration

## Overview

This feature connects Codex to Iranti through Codex's MCP client using the installed Iranti CLI surface. It provides a repeatable setup path for registering `iranti mcp` globally in Codex through either `iranti codex-setup` or `iranti integrate codex`, while keeping project-specific runtime resolution in `.env.iranti` and the linked instance env. The default registration is intentionally unpinned so one global Codex MCP entry can be reused across multiple bound repos.

## Inputs

| Input | Type | Description |
|---|---|---|
| `--name` | string | MCP server name to register in Codex. Defaults to `iranti`. |
| `--agent` | string | Default Iranti agent id for Codex sessions. Defaults to `codex_code`. |
| `--source` | string | Default provenance label used for writes through MCP. Defaults to `Codex`. |
| `--provider` | string | Optional `LLM_PROVIDER` override passed to the MCP process. |
| `--project-env` | string | Optional explicit `.env.iranti` path to pin the global Codex MCP server to one project. |
| `.env.iranti` | file | Project binding file containing `IRANTI_URL`, `IRANTI_API_KEY`, `IRANTI_AGENT_ID`, and `IRANTI_INSTANCE_ENV`. |
| linked instance env | file | Instance environment file referenced by `IRANTI_INSTANCE_ENV`, containing `DATABASE_URL`, `LLM_PROVIDER`, and provider keys. |

## Outputs

| Output | Type | Description |
|---|---|---|
| Codex MCP registration | global config entry | A registered MCP server in Codex pointing at `iranti mcp` by default. |
| `codex mcp get iranti` | CLI output | Verification of the stored Codex MCP configuration. |
| `codex -C <project>` | CLI command | Launches Codex in a bound project so `.env.iranti` is in scope for `iranti mcp`. |

## Decision Tree / Flow

1. Install Iranti globally and create a project binding with `iranti project init`.
2. Run `iranti codex-setup` or `iranti integrate codex`.
3. The setup script verifies `codex` is installed.
4. If a Codex MCP entry with the target name already exists, remove it.
5. Register a new global Codex MCP entry using `codex mcp add`.
6. If `--project-env` is provided, validate and store it as `IRANTI_PROJECT_ENV`. Otherwise leave the registration unpinned.
7. By default register `iranti mcp`; only use `--local-script` for repo-bound development.
8. Store only safe defaults and any explicitly requested pinned `IRANTI_PROJECT_ENV` in the MCP entry.
9. At runtime, `iranti mcp` loads `IRANTI_PROJECT_ENV` first when explicitly pinned and otherwise falls back to the active project/workspace.
10. Launch Codex with `codex -C <project>` for the intended workspace context.

## Edge Cases

- If `codex` is not installed, setup fails fast with a direct error that tells the user to confirm `codex --version` before retrying.
- Setup succeeds without `--project-env`; the MCP server then relies on runtime cwd-based resolution.
- If `--project-env` points to a missing file, setup fails fast.
- If the installed `iranti` CLI does not expose `iranti mcp`, setup can fall back to `--local-script`.
- If `dist/scripts/iranti-mcp.js` is missing in `--local-script` mode, setup fails and instructs the user to run `npm run build`.
- If a prior MCP entry exists, setup replaces it so reruns are deterministic.
- `DATABASE_URL` is not written into Codex config; the MCP process resolves `.env.iranti` and linked instance env at runtime instead.
- In multi-repo setups, the default unpinned registration avoids accidentally pinning all Codex sessions to one repo's `.env.iranti`.
- If the active project is missing `.env.iranti` or `IRANTI_INSTANCE_ENV`, MCP startup fails when Codex tries to connect.

## Test Results

- `npm run build` passes with the updated Codex setup script included.
- `iranti codex-setup` successfully registers `iranti` in Codex MCP config.
- `iranti integrate codex` resolves to the same setup path.
- `codex mcp get iranti` returns the expected installed-command MCP entry.

## Related

- `scripts/codex-setup.ts`
- `scripts/iranti-cli.ts`
- `scripts/iranti-mcp.ts`
- `docs/guides/codex.md`
- `docs/guides/claude-code.md`
