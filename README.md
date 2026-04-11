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
- **User operating rules** — define trigger-based rules that surface only when relevant
- **File-change recall** — agents remember which files changed and why

---

## Staff agents

Iranti is built around four internal Staff components that run alongside the host AI tool. Each Staff member has a specific job, and together they turn the memory layer into an active participant in the session — not just a dictionary the agent reads from.

| Staff | Role | What it does |
|---|---|---|
| **Librarian** | Writes and conflict resolution | Normalizes facts before storage, runs multi-step conflict resolution with cited evidence, enforces schema and confidence rules |
| **Attendant** | Turn-time context | Pre-response memory injection, mid-turn tool-call guidance, post-response autowrite nudges, drift detection, session objective tracking |
| **Archivist** | Background maintenance | Decays stale facts, archives expired entries, processes escalations, runs a bounded reasoning pass that proposes compressions and demotions |
| **Resolutionist** | Human-in-the-loop | Consumes escalation files for conflicts the Librarian could not auto-resolve |

### Attendant agency (what the Attendant surfaces on every turn)

The Attendant runs in three phases — `pre-response`, `mid-turn`, and `post-response` — and returns a structured result each time. Beyond raw fact injection, every `attend` response carries:

- **`toolCallGuidance`** — when the host passes a pending tool call (`Read`, `Grep`, `Glob`, `Bash`, `WebSearch`, `WebFetch`), the Attendant derives entity hints from the tool args and emits a `shouldSkip` verdict when stored facts already cover the target. Hosts can gate tool execution on the verdict instead of string-matching notes.
- **`drift`** — detects when the latest message has diverged from the declared task topic. Emits the driving tokens so the host can surface a confirmation prompt.
- **`sessionObjective`** — derived from the task description or checkpoint continuation, threaded through every attend call as a stable anchor.
- **`autoCheckpointSignal`** — fires when pressure has built up (drift, turns-without-write, tool-cost threshold) so the host can checkpoint before the next risky step.
- **`refinementPass`** — when the first retrieval pass comes back empty, the Attendant runs a bounded widened-hint retry (max 1 extra observe call) and reports the outcome.
- **`attendantToolPlan`** — up to three planned follow-up tool calls (search_related, observe_entity, query) derived from brief entities, drift tokens, or the session objective. Deterministic and surfaced, never executed.
- **`councilConsultationPlan`** — proposes which peer Staff members the Attendant would consult for this turn (e.g. Librarian for source-reliability on a clear topic, Archivist when the injection surface has multiple low-confidence facts). Proposal only.
- **`writeNudge`** — reminds the host to write a fact after substantial activity without a durable write.
- **`toolResultExtraction`** — on mid-turn/post-response, the Attendant extracts candidate facts from the tool result so the host can autowrite them.

### Archivist reasoning budget

Each Archivist scan cycle ends with a bounded, deterministic reasoning pass that emits proposals (never mutations) for the Resolutionist to consider:

- **compress** — clusters of duplicate entries at the same `entityType/entityId/key`
- **flag_drift** — clusters with high confidence spread suggesting disagreement
- **demote** — stale low-confidence single entries
- **review_stale** — very old single entries regardless of confidence

Proposals fire as `reasoning_proposal_emitted` staff events and travel on the `ArchivistReport` so callers can ship them onward.

### Council mode

Staff members can propose consultations with each other before finalising a decision. The Librarian can ask the Attendant for relevance when resolving a conflict; the Attendant can ask the Librarian for source-reliability context on a topic; the Resolutionist can ask the Archivist for pending reasoning-proposal context on an escalation. Consultations are proposed, bounded, and fired as `council_consultation_proposed` staff events — they are not executed automatically today.

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

## User Operating Rules

Rules are trigger-based instructions that surface only when the agent is about to do a relevant task (e.g. releasing, pushing to CI). Unlike project policies which are always injected, rules match against the current context using keyword triggers.

```bash
# Create a rule via MCP (iranti_write_rule tool) or the API
# Example: remind the agent to use GitHub Releases instead of npm publish
#   triggers: ["publish", "release", "npm"]
#   enforcement: "hard" (required) or "soft" (guidance)

# List all rules
iranti list-rules

# Remove a rule
iranti delete-rule no_npm_publish
```

Rules are stored as `rule/*` entities. During `iranti_attend`, triggers are matched against the current conversation context — single-word triggers match as tokens, multi-word triggers match as phrases.

---

## Diagnostics

```bash
iranti doctor              # Validate database, API key, and provider
iranti status              # Show known instances and project bindings
iranti chat                # Interactive chat shell for sanity checking
iranti upgrade --check     # Check for available updates
iranti upgrade --yes       # Apply updates
```

Operator-facing CLI help now includes short "what it does" and "use this when" guidance for every command — run `iranti --help` or `iranti <command> --help` for details.

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

- [Quickstart](docs/guides/quickstart.md)
- [Claude Code setup](docs/guides/claude-code.md)
- [Codex CLI setup](docs/guides/codex.md)
- [GitHub Copilot setup](docs/guides/copilot.md)
- [Python client](docs/guides/python-client.md)
- [Security quickstart](docs/guides/security-quickstart.md)
- [Operator manual](docs/guides/manual.md)
- [Conflict resolution](docs/guides/conflict-resolution.md)
- [Cross-tool handoffs](docs/guides/cross-tool-handoffs.md)
- [Vector backends](docs/guides/vector-backends.md)

## Links

- [Website](https://iranti.dev)
- [GitHub](https://github.com/nfemmanuel/iranti)
- [npm](https://www.npmjs.com/package/iranti)
- [Python client (PyPI)](https://pypi.org/project/iranti/)
- [TypeScript SDK](https://www.npmjs.com/package/@iranti/sdk)

## License

AGPL-3.0-or-later
