# Iranti

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)
[![MCP Server](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/badge/npm-iranti-red.svg)](https://www.npmjs.com/package/iranti)
[![npm version](https://img.shields.io/npm/v/iranti.svg)](https://www.npmjs.com/package/iranti)

**Shared memory for AI coding tools — Claude Code, Codex CLI, and GitHub Copilot.**

Iranti is a self-hosted MCP server that gives your AI tools persistent, identity-based memory. Facts written in one session are retrievable in any other — across tools, projects, and context resets.

---

## Quick Start

```bash
# Install globally
npm install -g iranti

# Run the guided setup (configures database, API key, project binding)
iranti setup

# Start the instance
iranti run --instance local
```

Then wire it into your AI tool:

```bash
iranti claude-setup    # Claude Code
iranti codex-setup     # Codex CLI
iranti copilot-setup   # GitHub Copilot
```

That's it. Your AI tool now has persistent memory across sessions.

---

## Supported Tools

| Tool | Command | What it does |
|---|---|---|
| **Claude Code** | `iranti claude-setup` | Adds `.mcp.json`, `CLAUDE.md`, and session hooks |
| **Codex CLI** | `iranti codex-setup` | Registers Iranti in the global MCP registry |
| **GitHub Copilot** | `iranti copilot-setup` | Writes MCP config to `.mcp.json` + `.vscode/mcp.json`, protocol instructions to `.github/copilot-instructions.md` |
| **Any MCP client** | `iranti mcp` | Runs the stdio MCP server directly |

---

## What It Does

Iranti stores facts as `entityType/entityId → key → value` triples in PostgreSQL. Any agent that knows the entity and key can retrieve the fact exactly — no semantic guessing, no hallucinated state.

```
Agent A writes:  project/my-app → deployment_status → "deployed to staging"
Agent B reads:   project/my-app → deployment_status → "deployed to staging" ✓
```

Facts persist across sessions, context resets, and tool switches. When you restart Claude Code tomorrow, it can pick up exactly where you left off.

### Key capabilities

- **Exact lookup** — retrieve by `entityType/entityId + key`, deterministic and fast
- **Hybrid search** — lexical + vector similarity when exact keys are unknown
- **Cross-tool sharing** — Claude Code, Codex, and Copilot share the same memory
- **Conflict resolution** — concurrent writes from multiple agents are detected and resolved
- **Per-fact confidence** — every fact carries a confidence score; low-confidence facts age out
- **Session recovery** — checkpoint/resume for interrupted work
- **User operating rules** — define rules that surface only when relevant (v0.3.20)
- **File-change recall** — agents remember which files changed and why (v0.3.20)

---

## MCP Tools

When connected via MCP, Iranti exposes these tools to your AI tool:

| Tool | Purpose |
|---|---|
| `iranti_handshake` | Initialize session, load operating rules and working memory |
| `iranti_attend` | Pre/post-response memory injection — call before every reply |
| `iranti_write` | Write a durable fact to shared memory |
| `iranti_query` | Exact entity+key lookup |
| `iranti_search` | Hybrid semantic/lexical search |
| `iranti_checkpoint` | Save current task progress |
| `iranti_ingest` | Extract facts from prose or documents |
| `iranti_relate` | Create a relationship between two entities |
| `iranti_related` / `iranti_related_deep` | Traverse entity relationships |
| `iranti_history` | Fact history with timestamps |
| `iranti_who_knows` | Find which agents have written about an entity |
| `iranti_observe` | Demand-driven context injection with entity hints |
| `iranti_write_rule` | Write a user operating rule with trigger conditions |
| `iranti_remember_response` | Auto-persist facts from an assistant response |

---

## Install Strategy

Iranti uses a two-layer model: one machine-level runtime, many project bindings.

### 1. Install and set up

```bash
npm install -g iranti
iranti setup
```

`iranti setup` walks you through:
- Instance creation and database onboarding (local Postgres, managed Postgres, or Docker)
- LLM provider API keys (OpenAI, Claude, Gemini, Groq, Mistral, or local Ollama)
- Project binding

Non-interactive automation:

```bash
iranti setup --defaults --db-url "postgresql://postgres:yourpassword@localhost:5432/iranti"
```

### 2. Start the instance

```bash
iranti run --instance local
```

### 3. Bind a project

```bash
cd /path/to/your/project
iranti project init . --instance local --agent-id my_agent
```

This writes `.env.iranti` with `IRANTI_URL`, `IRANTI_API_KEY`, and agent identity. Each agent in a multi-agent system gets its own `--agent-id`.

### 4. Integrate with your AI tool

```bash
iranti claude-setup    # or codex-setup / copilot-setup
```

---

## API Keys

```bash
# Create a scoped key for one user or service
iranti auth create-key --instance local --key-id my_app --owner "My App" \
  --scopes "kb:read,kb:write,memory:read,memory:write"

# List keys
iranti list api-keys --instance local

# Revoke a key
iranti auth revoke-key --instance local --key-id my_app
```

---

## SDK Usage

**Python** ([PyPI](https://pypi.org/project/iranti/)):

```python
from iranti import IrantiClient

client = IrantiClient(base_url="http://localhost:3001", api_key="your_key")

# Write a fact
client.write(
    entity="project/my-app",
    key="status",
    value="in_review",
    summary="App is in review",
    confidence=90,
    source="my_script",
    agent="my_agent",
)

# Read it back
fact = client.query(entity="project/my-app", key="status")
```

**TypeScript** ([npm](https://www.npmjs.com/package/@iranti/sdk)):

```typescript
import { IrantiClient } from "@iranti/sdk";

const client = new IrantiClient({ baseUrl: "http://localhost:3001", apiKey: "your_key" });

await client.write({
    entity: "project/my-app",
    key: "status",
    value: "in_review",
    summary: "App is in review",
    confidence: 90,
    source: "my_script",
    agent: "my_agent",
});

const fact = await client.query("project/my-app", "status");
```

---

## Diagnostics

```bash
iranti doctor              # Validate database, API key, and provider
iranti status              # Show known instances and project bindings
iranti upgrade --check     # Check for available updates
iranti upgrade --yes       # Apply updates
```

---

## Configuration

Environment variables (set during `iranti setup` or manually in `.env`):

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (pgvector required) |
| `IRANTI_API_KEY` | Server authentication key |
| `LLM_PROVIDER` | `openai` \| `claude` \| `gemini` \| `groq` \| `mistral` \| `ollama` \| `mock` |
| `IRANTI_PORT` | API port (default: `3001`) |
| `IRANTI_ARCHIVIST_WATCH` | Watch escalation files and auto-run maintenance (`true`/`false`) |

---

## Uninstall

```bash
iranti uninstall --dry-run    # Preview what would be removed
iranti uninstall --all --yes  # Remove runtime + project bindings
```

---

## Guides

- [Claude Code setup](docs/guides/claude-code.md)
- [Codex CLI setup](docs/guides/codex.md)
- [Python client](docs/guides/python-client.md)
- [Security quickstart](docs/guides/security-quickstart.md)
- [Operator manual](docs/guides/manual.md)
- [Conflict resolution](docs/guides/conflict-resolution.md)
- [Vector backends](docs/guides/vector-backends.md)

## Links

- [Website](https://iranti.dev)
- [GitHub](https://github.com/nfemmanuel/iranti)
- [npm](https://www.npmjs.com/package/iranti)
- [Python client (PyPI)](https://pypi.org/project/iranti/)
- [TypeScript SDK](https://www.npmjs.com/package/@iranti/sdk)

## License

AGPL-3.0-or-later
