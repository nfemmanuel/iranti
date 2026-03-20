# Claude Code Guide

Use Iranti with Claude Code through:
- `iranti claude-setup` for project-local MCP + hook scaffolding
- `iranti mcp` for explicit memory tools
- `iranti claude-hook` for automatic working-memory injection

This guide is written for the installed-package path, not for running Iranti out of a source checkout.

## Prerequisites

- `npm install -g iranti`
- a running Iranti instance, for example `iranti run --instance local`
- a project binding created with `iranti project init`

Example project binding:

```bash
cd /path/to/your/project
iranti project init . --instance local --agent-id claude_code_main
```

That writes `.env.iranti` with:
- `IRANTI_URL`
- `IRANTI_API_KEY`
- `IRANTI_AGENT_ID`
- `IRANTI_INSTANCE_ENV`

`iranti mcp` and `iranti claude-hook` automatically load `.env.iranti` from the current project directory and then load the linked instance env to recover:
- `DATABASE_URL`
- `LLM_PROVIDER`
- upstream provider API keys

## 1. Start the Iranti API instance

In one terminal:

```bash
iranti run --instance local
```

## 2. Scaffold the Claude Code files

From the bound project:

```bash
iranti claude-setup
```

This writes or refreshes:
- `.mcp.json`
- `.claude/settings.local.json`

Use `--force` if you want Iranti to overwrite existing scaffold files.

Batch mode for a parent projects folder:

```bash
iranti claude-setup --scan "C:/Users/NF/Documents/Projects"
```

Recursive scan for nested project trees:

```bash
iranti claude-setup --scan "C:/Users/NF/Documents/Projects" --recursive
```

Scan mode:
- checks immediate subdirectories only
- add `--recursive` to walk nested project folders too
- only touches directories that already contain `.claude/`
- adds or merges an `iranti` MCP server into `.mcp.json`
- only creates `.claude/settings.local.json` when it is missing, unless `--force` is supplied

Equivalent alias:

```bash
iranti integrate claude
```

## 3. Add project-local MCP config manually

If you do not want to use `iranti claude-setup`, create the files yourself.

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "iranti": {
      "command": "iranti",
      "args": ["mcp"]
    }
  }
}
```

This exposes these tools to Claude Code:
- `iranti_handshake`
- `iranti_attend`
- `iranti_observe`
- `iranti_query`
- `iranti_search`
- `iranti_write`
- `iranti_ingest`
- `iranti_relate`
- `iranti_who_knows`

## 4. Add Claude Code hooks

Create `.claude/settings.local.json` in the same project:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "iranti claude-hook --event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "iranti claude-hook --event UserPromptSubmit"
          }
        ]
      }
    ]
  }
}
```

The hook uses `.env.iranti` in the current project automatically. You do not need to hardcode `DATABASE_URL` into the hook command.

Optional explicit overrides:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "iranti claude-hook --event SessionStart --project-env \"C:/path/to/project/.env.iranti\""
          }
        ]
      }
    ]
  }
}
```

## 5. Recommended usage policy

Use the integration like this:

- `iranti_query` when you know the exact entity and key
- `iranti_search` when you do not know the key yet
- `iranti_attend` or hooks for short-turn working-memory retrieval
- `iranti_write` only for durable facts
- `iranti_ingest` for larger stable text blocks worth chunking

Do not auto-save every Claude turn. That will pollute the Library and reduce retrieval quality over time.

## 6. Suggested Claude standing instruction

```text
Use Iranti for durable memory. Prefer iranti_query for exact lookup, iranti_search for discovery, and iranti_write only for stable facts such as preferences, decisions, constraints, task state, and repository knowledge.
```

## 7. Verification

From the project root:

```bash
iranti mcp --help
iranti claude-setup --help
iranti claude-hook --help
iranti doctor
```

Inside Claude Code, verify:

1. Ask: `What MCP tools are available?`
2. Ask: `Use Iranti to search for initialization log`
3. Ask: `Tell me whether memory context was injected at session start`

Important:
- Protected Staff Namespace entries such as `system/library/schema_version` are intentionally hidden from regular agent queries.
- If you want to test retrieval, use a non-protected project/user/entity fact instead.

## 8. Troubleshooting

If Claude Code does not surface Iranti tools:

1. Confirm the CLI subcommands exist:

```bash
iranti mcp --help
iranti claude-setup --help
iranti claude-hook --help
```

2. Confirm the project binding exists:

```bash
type .env.iranti
```

3. Confirm the linked instance is healthy:

```bash
iranti doctor --instance local
```

4. Confirm the hook can resolve env automatically:

```bash
echo {} | iranti claude-hook --event SessionStart
```

5. Inspect the Attendant manually if you need to debug memory loading:

```bash
iranti handshake --task "Debug Claude Code memory"
iranti attend "What did we decide earlier?" --context-file transcript.txt
```

Use `--json` if you want the raw brief or attend decision. These commands are for debugging and operator inspection. They do not replace the normal Claude Code hook + MCP flow.

If the hook says `DATABASE_URL is required`, the current project is missing `.env.iranti` or `IRANTI_INSTANCE_ENV`.

If you used `--scan`, remember:
- scan mode does not create `.env.iranti`
- scan mode is for broad MCP scaffolding, not full per-project binding

## Related

- `scripts/iranti-cli.ts`
- `scripts/iranti-mcp.ts`
- `scripts/claude-code-memory-hook.ts`
- `src/lib/runtimeEnv.ts`
- `docs/features/claude-code-mcp/spec.md`
