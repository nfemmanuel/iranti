# Codex Guide

Use Iranti with Codex through a global MCP registration plus this repo's `AGENTS.md`.

Unlike Claude Code, Codex does not use a project-local `.mcp.json`. Codex reads MCP server registrations from its global config and reads workspace instructions from the repository itself. In this repo, that means:
- register the Iranti MCP server once with `codex mcp add`
- launch Codex with this repo as the working root so `AGENTS.md` applies

## Prerequisites

- Codex CLI installed and on `PATH`
- Node.js 18+
- A working Iranti database (`DATABASE_URL` in this repo's `.env`)
- `npm install`
- `npm run build`

## 1. Register Iranti with Codex

Run:

```bash
npm run codex:setup
```

What it does:
- verifies `codex` is installed
- replaces any existing Codex MCP entry named `iranti`
- registers `node dist/scripts/iranti-mcp.js` as a global Codex MCP server
- stores only safe defaults like `IRANTI_MCP_DEFAULT_AGENT=codex_code`

It does **not** store `DATABASE_URL` inside Codex config. The MCP server loads `.env` from this repo at runtime.

Optional overrides:

```bash
npm run codex:setup -- --name iranti --agent codex_code --source Codex --provider gemini
```

## 2. Launch Codex in This Repo

Run:

```bash
npm run codex:run
```

Equivalent direct command:

```bash
codex -C .
```

That ensures Codex uses this repository as its working root, which is how it picks up `AGENTS.md`.

## 3. Verify the MCP Registration

List configured MCP servers:

```bash
codex mcp list
```

Inspect the Iranti entry:

```bash
codex mcp get iranti
```

## 4. Verify in the Codex App

If you use the downloadable Codex app, configure MCP through the CLI first, then open the app.

Verification checklist:

1. Run `codex mcp list` in a terminal and confirm `iranti` is present.
2. Open the Codex app after the MCP registration already exists.
3. Open this repository as the active workspace so `AGENTS.md` is in scope.
4. Start a session and ask Codex to check available tools or query Iranti.
5. Confirm Codex can invoke one of the Iranti tools such as `iranti_query`.

Suggested smoke test:

```text
Use iranti_query to look up system/library/schema_version.
```

If the app does not expose the Iranti tools:
- confirm `codex mcp get iranti` still returns the registration
- restart the Codex app after registration changes
- make sure the app is using this repository as the working root
- make sure this repo's `.env` contains a valid `DATABASE_URL`

## 5. Available Iranti Tools in Codex

Once registered, Codex can use:
- `iranti_handshake`
- `iranti_attend`
- `iranti_observe`
- `iranti_query`
- `iranti_search`
- `iranti_write`
- `iranti_ingest`
- `iranti_relate`
- `iranti_who_knows`

## 6. Recommended Usage Policy

Use the integration like this:

- `iranti_query` when you know the exact entity and key
- `iranti_search` when you need discovery
- `iranti_attend` when the active turn may need memory injection
- `iranti_write` only for durable facts
- `iranti_ingest` only for stable content worth chunking

Do **not** auto-save every turn. That degrades retrieval quality quickly.

## 7. Suggested Standing Instruction

Codex already reads this repo's `AGENTS.md`, but a good short standing instruction is:

```text
Use Iranti for durable memory. Prefer iranti_query for exact lookup, iranti_search for discovery, and iranti_write only for stable facts such as decisions, constraints, preferences, project state, and repository knowledge.
```

## Related

- `scripts/codex-setup.ts`
- `scripts/iranti-mcp.ts`
- `docs/features/codex-mcp/spec.md`
- `docs/guides/claude-code.md`
