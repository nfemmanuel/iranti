# Claude Code Guide

Use Iranti with Claude Code through two layers:
- a local **MCP server** for explicit memory tools
- optional **hooks** for automatic working-memory injection

This is the right integration shape because Claude Code supports both MCP and hook-based context injection.

## Prerequisites

- Node.js 18+
- A working Iranti database (`DATABASE_URL`)
- `npm install`
- `npm run build`

## 1. Start the Iranti MCP Server

Run the stdio MCP server:

```bash
node dist/scripts/iranti-mcp.js
```

Useful environment variables:

```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/iranti
LLM_PROVIDER=gemini
IRANTI_MCP_DEFAULT_AGENT=claude_code
IRANTI_MCP_DEFAULT_SOURCE=ClaudeCode
```

## 2. Project-Scoped Claude Code MCP Config

Create a project-local `.mcp.json` next to your codebase.

Example:

```json
{
  "mcpServers": {
    "iranti": {
      "command": "node",
      "args": ["dist/scripts/iranti-mcp.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:yourpassword@localhost:5432/iranti",
        "LLM_PROVIDER": "gemini",
        "IRANTI_MCP_DEFAULT_AGENT": "claude_code_project"
      }
    }
  }
}
```

This gives Claude Code explicit tools:
- `iranti_handshake`
- `iranti_attend`
- `iranti_observe`
- `iranti_query`
- `iranti_search`
- `iranti_write`
- `iranti_ingest`
- `iranti_relate`
- `iranti_who_knows`

## 3. Optional Hook Helper

The hook helper is for automatic memory reads, not automatic storage.

Supported events:
- `SessionStart`
- `UserPromptSubmit`

The helper reads Claude Code hook JSON from stdin and returns `hookSpecificOutput.additionalContext`.

### POSIX-style example

Add a project-local `.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "DATABASE_URL='postgresql://postgres:yourpassword@localhost:5432/iranti' node dist/scripts/claude-code-memory-hook.js --event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "DATABASE_URL='postgresql://postgres:yourpassword@localhost:5432/iranti' node dist/scripts/claude-code-memory-hook.js --event UserPromptSubmit"
          }
        ]
      }
    ]
  }
}
```

### Windows PowerShell-style example

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$env:DATABASE_URL='postgresql://postgres:yourpassword@localhost:5432/iranti'; node dist/scripts/claude-code-memory-hook.js --event SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$env:DATABASE_URL='postgresql://postgres:yourpassword@localhost:5432/iranti'; node dist/scripts/claude-code-memory-hook.js --event UserPromptSubmit"
          }
        ]
      }
    ]
  }
}
```

## 4. Recommended Usage Policy

Use the integration like this:

- `iranti_query` when you know the exact entity and key
- `iranti_search` when you do not know the key yet
- `iranti_attend` or hooks for short-turn working-memory retrieval
- `iranti_write` only for durable facts
- `iranti_ingest` for larger stable text blocks worth chunking

Do **not** auto-save every Claude turn. That will pollute the Library and reduce retrieval quality over time.

## 5. Suggested Claude Behavior

If you want Claude Code to use Iranti consistently, give it a short standing instruction such as:

```text
Use Iranti for durable memory. Prefer iranti_query for exact lookup, iranti_search for discovery, and iranti_write only for stable facts such as preferences, decisions, constraints, task state, and repository knowledge.
```

## 6. Verification

After building, verify both scripts exist:

```bash
node dist/scripts/iranti-mcp.js --help
node dist/scripts/claude-code-memory-hook.js --help
```

## Related

- `scripts/iranti-mcp.ts`
- `scripts/claude-code-memory-hook.ts`
- `docs/features/claude-code-mcp/spec.md`
