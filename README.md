# Iranti

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)
[![Python](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![CrewAI Compatible](https://img.shields.io/badge/CrewAI-compatible-green.svg)](https://www.crewai.com/)

**Memory infrastructure for multi-agent AI systems.**

Iranti gives agents persistent, identity-based memory. Facts written by one agent are retrievable by any other agent through exact entity+key lookup. Iranti also supports hybrid search (lexical + vector) when exact keys are unknown. Memory persists across sessions and survives context window limits.

---

## What is Iranti?

Iranti is a knowledge base for multi-agent systems. The primary read path is identity retrieval — this specific entity (`project/nexus_prime`), this specific key (`deadline`), with confidence attached. When Agent A writes a fact, Agent B can retrieve it by exact lookup without being told it exists. Facts persist in PostgreSQL and survive context window boundaries through the `observe()` API. For discovery workflows, Iranti supports hybrid search (full-text + vector similarity).

---

## Runtime Roles

- **User**: Person who interacts with an app or chatbot built on Iranti.
- **Agent**: External AI worker that writes/reads facts through Iranti APIs.
- **Attendant**: Per-agent memory manager that decides what to inject for each turn.
- **Librarian**: Conflict-aware writer that owns all KB writes.
- **Library**: Active truth store (`knowledge_base`) in PostgreSQL.
- **Archive**: Historical/superseded truth store (`archive`) in PostgreSQL.
- **Archivist**: Maintenance worker that archives stale/low-confidence facts and processes resolved escalations.

---

## Why Not a Vector Database?

| Feature | Vector DB | Iranti |
|---|---|---|
| **Retrieval** | Similarity (nearest neighbor) | Identity-first + optional hybrid search |
| **Storage** | Embeddings in vector space | Structured facts with keys |
| **Persistence** | Stateless between calls | Persistent across sessions |
| **Confidence** | No confidence tracking | Per-fact confidence scores |
| **Conflicts** | No conflict resolution | Automatic resolution + escalation |
| **Context** | No context awareness | `observe()` injects missing facts |

Vector databases answer "what's similar to X?" Iranti answers "what do we know about X?" and can run hybrid search when exact keys are unknown.

---

## Validated Results

All five goals validated with fictional entities and invented facts that GPT-4o-mini cannot know from training data.

| Goal | Experiment | Score | Status |
|---|---|---|---|
| **1. Easy Integration** | Raw HTTP (9 lines) | 3/3 facts | ✓ PASSED |
| **2. Context Persistence** | observe() API | 6/6 injected | ✓ PASSED |
| **3. Working Retrieval** | Cross-agent query | 5/5 facts | ✓ PASSED |
| **4. Per-Agent Persistence** | Cross-process | 5/5 facts | ✓ PASSED |
| **5. Response Quality** | Memory injection | 0/2 → 2/2 | ✓ PASSED |

### Framework Compatibility

Validated with multiple agent frameworks:

| Framework | Entity | Facts | Score | Time |
|---|---|---|---|---|
| **Raw OpenAI API** | project/void_runner | 5 | 5/5 ✓ | 14.0s |
| **LangChain** | project/stellar_drift | 5 | 5/5 ✓ | 2.9s |
| **CrewAI** | project/nexus_prime | 6 | 6/6 ✓ | 60s |

**Total: 16/16 facts transferred (100%)**

Full validation report: [`docs/internal/validation_results.md`](docs/internal/validation_results.md) | Multi-framework details: [`docs/internal/MULTI_FRAMEWORK_VALIDATION.md`](docs/internal/MULTI_FRAMEWORK_VALIDATION.md)

### Goal 1: Easy Integration

- **Entity**: `project/quantum_bridge`
- **Test**: Integrate Iranti with raw HTTP in under 20 lines of Python
- **Result**: 9 lines of code, 3/3 facts written and retrieved
- **Conclusion**: No SDK or framework dependencies required, just standard `requests` library

### Goal 2: Context Persistence

- **Entity**: `project/nexus_prime`
- **Control**: Facts already in context → `observe()` returns 0 to inject (correct, avoids duplication)
- **Treatment**: Facts missing from context → `observe()` returns 6/6 facts for injection
- **Result**: 100% recovery rate when facts fall out of context window

### Goal 3: Working Retrieval

- **Entity**: `project/photon_cascade`
- **Test**: Agent 2 retrieves facts written by Agent 1 with zero shared context
- **Result**: 5/5 facts retrieved via identity-based lookup (entity+key)
- **Conclusion**: Facts accessible across agents with no context window dependency

### Goal 4: Per-Agent Knowledge Persistence

- **Entity**: `project/resonance_field`
- **Test**: Process 1 writes facts and exits, Process 2 reads in new process
- **Result**: 5/5 facts retrieved with no shared state between processes
- **Conclusion**: PostgreSQL storage validated, facts survive across sessions

### Goal 5: Response Quality

- **Entity**: `project/meridian_core`
- **Test**: Ask LLM question requiring facts from earlier in long conversation
- **Control**: Without Iranti → 0/2 facts correct (hallucinated answers)
- **Treatment**: With Iranti memory injection → 2/2 facts correct (accurate answers)
- **Conclusion**: Memory injection eliminates hallucination, improves response accuracy

Full validation report: [`docs/internal/validation_results.md`](docs/internal/validation_results.md)

## Quickstart

**Requirements**: Node.js 18+, Docker, Python 3.8+

```bash
# 1. Clone and configure
git clone https://github.com/nfemmanuel/iranti
cd iranti
cp .env.example .env          # Set DATABASE_URL and IRANTI_API_KEY

# Optional runtime hygiene
# IRANTI_ESCALATION_DIR=C:/Users/<you>/.iranti/escalation
# IRANTI_ARCHIVIST_WATCH=true
# IRANTI_ARCHIVIST_DEBOUNCE_MS=60000
# IRANTI_ARCHIVIST_INTERVAL_MS=21600000

# 2. Start PostgreSQL
docker-compose up -d

# 3. Install and initialize
npm install
npm run setup                 # Runs migrations

# 4. Start API server
npm run api                   # Runs on port 3001

# 5. Install Python client
pip install iranti
```

### Archivist Scheduling Knobs

- `IRANTI_ARCHIVIST_WATCH=true` enables file-change watching on escalation `active/`.
- `IRANTI_ARCHIVIST_DEBOUNCE_MS=60000` runs maintenance 60s after the latest file change.
- `IRANTI_ARCHIVIST_INTERVAL_MS=21600000` runs maintenance every 6 hours (set `0` to disable).
- `IRANTI_ESCALATION_DIR` sets escalation storage root. Default is `~/.iranti/escalation`, keeping escalation files out of the repo by default.

### Per-User API Keys (Recommended)

```bash
# Create a key for one user/app (prints token once)
npm run api-key:create -- --key-id chatbot_alice --owner "Alice chatbot" --scopes "kb:read,kb:write,memory:read,memory:write,agents:read,agents:write"

# List keys
npm run api-key:list

# Revoke a key
npm run api-key:revoke -- --key-id chatbot_alice
```

Use the printed token (`keyId.secret`) as `X-Iranti-Key`.
Scopes use `resource:action` format (for example `kb:read`, `memory:write`, `metrics:read`, `proxy:chat`).

### Security Baseline

- Use one scoped key per app/service identity.
- Rotate any key that is exposed in logs, screenshots, or chat.
- Keep escalation/log paths outside the repo working tree.
- Use TLS/reverse proxy for non-local deployments.

Security quickstart: [`docs/guides/security-quickstart.md`](docs/guides/security-quickstart.md)
Claude Code guide: [`docs/guides/claude-code.md`](docs/guides/claude-code.md)
Release guide: [`docs/guides/releasing.md`](docs/guides/releasing.md)

### Claude Code via MCP

Iranti ships a local stdio MCP server for Claude Code and other MCP clients:

```bash
npm run build
node dist/scripts/iranti-mcp.js
```

Use it with a project-local `.mcp.json`, and optionally add the Claude Code hook helper for `SessionStart` and `UserPromptSubmit`.

Guide: [`docs/guides/claude-code.md`](docs/guides/claude-code.md)

---

## Install Strategy (Double Layer)

Iranti now supports a two-layer install flow:

1. **Machine/runtime layer**: one local runtime root with one or more named Iranti instances.
2. **Project layer**: each chatbot/app binds to one instance with a local `.env.iranti`.

### 1) Install CLI

```bash
# If published package is available
npm install -g iranti

# Or from this repo (local simulation)
npm install -g .
```

### 2) Initialize machine runtime root

```bash
iranti install --scope user
```

Defaults:
- Windows user scope: `%USERPROFILE%\\.iranti`
- Windows system scope: `%ProgramData%\\Iranti`
- Linux system scope: `/var/lib/iranti`
- macOS system scope: `/Library/Application Support/Iranti`

### 3) Create a named instance

```bash
iranti instance create local --port 3001 --db-url "postgresql://postgres:yourpassword@localhost:5432/iranti_local"
iranti instance show local
```

Then edit the printed instance `.env` file and set:
- `DATABASE_URL` (real value)
- `IRANTI_API_KEY` (real token)

### 4) Run Iranti from that instance

```bash
iranti run --instance local
```

### 5) Bind any chatbot/app project to that instance

```bash
cd /path/to/your/chatbot
iranti project init . --instance local --agent-id chatbot_main
```

This writes `.env.iranti` in the project with the correct `IRANTI_URL`, `IRANTI_API_KEY`, and default agent identity.

For multi-agent systems, bind once per project and set unique agent IDs per worker (for example `planner_agent`, `research_agent`, `critic_agent`).

---

## Core API

### Write a Fact

```python
from clients.python.iranti import IrantiClient

client = IrantiClient(
    base_url="http://localhost:3001",
    api_key="your_api_key_here"
)

result = client.write(
    entity="researcher/jane_smith",      # Format: entityType/entityId
    key="affiliation",
    value={"institution": "MIT", "department": "CSAIL"},
    summary="Affiliated with MIT CSAIL",  # Compressed for working memory
    confidence=85,                        # 0-100
    source="OpenAlex",
    agent="research_agent_001"
)

print(result.action)  # 'created', 'updated', 'escalated', or 'rejected'
```

### Query a Fact

```python
result = client.query("researcher/jane_smith", "affiliation")

if result.found:
    print(result.value)       # {"institution": "MIT", "department": "CSAIL"}
    print(result.confidence)  # 85
    print(result.source)      # "OpenAlex"
```

### Query All Facts for an Entity

```python
facts = client.query_all("researcher/jane_smith")

for fact in facts:
    print(f"[{fact['key']}] {fact['summary']} (confidence: {fact['confidence']})")
```

### Hybrid Search

```python
matches = client.search(
    query="current blocker launch readiness",
    entity_type="project",
    limit=5,
    lexical_weight=0.45,
    vector_weight=0.55,
)

for item in matches:
    print(item["entity"], item["key"], item["score"])
```

### Context Persistence (attend)

```python
# Before each LLM call, let Attendant decide if memory is needed
result = client.attend(
    agent_id="research_agent_001",
    latest_message="What's Jane Smith's current affiliation?",
    current_context="User: What's Jane Smith's current affiliation?\nAssistant: Let me check...",
    max_facts=5
)

if result["shouldInject"]:
    for fact in result['facts']:
        print(f"Inject: [{fact['entityKey']}] {fact['summary']}")
```

### Working Memory (handshake)

```python
# At session start, get personalized brief for agent's current task
brief = client.handshake(
    agent="research_agent_001",
    task="Research publication history for Dr. Jane Smith",
    recent_messages=["Starting literature review..."]
)

print(brief.operating_rules)      # Staff namespace rules for this agent
print(brief.inferred_task_type)   # e.g. "research", "verification"

for entry in brief.working_memory:
    print(f"{entry.entity_key}: {entry.summary}")
```

---

## CrewAI Integration

Minimal working example based on validated experiments:

```python
from crewai import Agent, Task, Crew, LLM
from crewai.tools import tool
from clients.python.iranti import IrantiClient

iranti = IrantiClient(base_url="http://localhost:3001", api_key="your_key")
ENTITY = "project/my_project"

@tool("Write finding to shared memory")
def write_finding(key: str, value: str, summary: str, confidence: int) -> str:
    """Write a fact to Iranti so other agents can access it."""
    result = iranti.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=summary,
        confidence=confidence,
        source="briefing_doc",
        agent="researcher_agent"
    )
    return f"Saved '{key}': {result.action}"

@tool("Get all findings")
def get_all_findings() -> str:
    """Load all facts from Iranti."""
    facts = iranti.query_all(ENTITY)
    if not facts:
        return "No findings in shared memory."
    lines = [f"[{f['key']}] {f['summary']} (confidence: {f['confidence']})" for f in facts]
    return "\n".join(lines)

# Researcher agent: writes to Iranti
researcher = Agent(
    role="Research Analyst",
    goal="Extract facts from documents and save to shared memory",
    tools=[write_finding],
    llm=LLM(model="gpt-4o-mini")
)

# Analyst agent: reads from Iranti
analyst = Agent(
    role="Project Analyst",
    goal="Summarize projects using shared memory",
    tools=[get_all_findings],
    llm=LLM(model="gpt-4o-mini")
)

# Researcher extracts facts, analyst loads them — no direct communication needed
crew = Crew(agents=[researcher, analyst], tasks=[...])
crew.kickoff()
```

**Result**: Analyst successfully loads all facts written by researcher (validated 6/6 transfer rate).

---

## Middleware for Any LLM

Add Iranti memory to Claude, ChatGPT, or any LLM via API wrapper:

```python
from clients.middleware.iranti_middleware import IrantiMiddleware

middleware = IrantiMiddleware(
    agent_id="my_agent",
    iranti_url="http://localhost:3001"
)

# Before sending to LLM
augmented = middleware.before_send(
    user_message="What was the blocker?",
    conversation_history=[...]
)

# After receiving response
middleware.after_receive(
    response="The blocker is...",
    conversation_history=[...]
)
```

**How it works**:
1. `before_send()` calls `attend()` with conversation context
2. Forgotten facts are prepended as `[MEMORY: ...]`
3. `after_receive()` extracts new facts and saves them (best-effort)

**Note**: Browser extensions are blocked by ChatGPT and Claude's Content Security Policy. Use API-based middleware instead.

**Examples**: [`clients/middleware/claude_example.py`](clients/middleware/claude_example.py)

---

## Architecture

Iranti has four internal components:

| Component | Role |
|---|---|
| **Library** | PostgreSQL knowledge base. Active truth in `knowledge_base` with full provenance in `archive`; archived rows are retained and marked `[ARCHIVED]` in active storage. |
| **Librarian** | Manages all writes. Detects conflicts, reasons about resolution, escalates when uncertain. |
| **Attendant** | Per-agent working memory manager. Implements `attend()`, `observe()`, and `handshake()` APIs. |
| **Archivist** | Periodic cleanup. Archives expired and low-confidence entries. Processes human-resolved conflicts. |

### REST API

Express server on port 3001 with endpoints:

- `POST /kb/write` - Write atomic fact
- `POST /kb/ingest` - Ingest raw text, auto-chunk into facts
- `GET /kb/query/:entityType/:entityId/:key` - Query specific fact
- `GET /kb/query/:entityType/:entityId` - Query all facts for entity
- `GET /kb/search` - Hybrid search across facts
- `POST /memory/attend` - Decide whether to inject memory for this turn
- `POST /memory/observe` - Context persistence (inject missing facts)
- `POST /memory/handshake` - Working memory brief for agent session
- `POST /kb/relate` - Create entity relationship
- `GET /kb/related/:entityType/:entityId` - Get related entities
- `POST /agents/register` - Register agent in registry

All endpoints require `X-Iranti-Key` header for authentication.

---

## Schema

Six PostgreSQL tables:

```
knowledge_base          - active truth (archived rows retained with confidence=0)
archive                 - full provenance history, never deleted
entity_relationships    - directional graph: MEMBER_OF, PART_OF, AUTHORED, etc.
entities                - canonical entity identity registry
entity_aliases          - normalized aliases mapped to canonical entities
write_receipts          - idempotency receipts for requestId replay safety
```

New entity types, relationship types, and fact keys do not require migrations; they are caller-defined strings.

**Archive semantics**: When an entry is archived, it remains in knowledge_base with confidence set to 0 and summary marked as `[ARCHIVED]`. A full copy is written to the archive table for traceability. Nothing is ever truly deleted.

---

## Running Tests

```bash
npm run test:integration      # Full end-to-end
npm run test:librarian        # Conflict resolution
npm run test:attendant        # Working memory
npm run test:reliability      # Source scoring

# Python validation experiments
cd clients/experiments
python validate_nexus_observe.py        # Context persistence
python validate_nexus_treatment.py      # Cross-agent transfer
```

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0) - see [LICENSE](LICENSE) file for details.

Free to use, modify, and distribute under AGPL terms. If you offer Iranti as a hosted service and modify it, AGPL requires publishing those modifications.

---

## Name

Iranti is the Yoruba word for memory and remembrance.

---

## Project Structure

```
src/
├── library/            — DB client, queries, relationships, agent registry
├── librarian/          — Write logic, conflict resolution, reliability
├── attendant/          — Per-agent working memory, observe() implementation
├── archivist/          — Periodic cleanup, escalation processing
├── lib/                — LLM abstraction, model router, providers
├── sdk/                — Public TypeScript API
└── api/                — REST API server

clients/
├── python/             — Python client (IrantiClient)
├── middleware/         — LLM conversation wrappers (Claude, ChatGPT, etc.)
└── experiments/        — Validated experiments with real results

docs/
└── internal/validation_results.md  — Full experiment outputs and analysis
```

---

## Support

- **Issues**: [GitHub Issues](https://github.com/nfemmanuel/iranti/issues)
- **Discussions**: [GitHub Discussions](https://github.com/nfemmanuel/iranti/discussions)
- **Email**: oluwaniifemi.emmanuel@uni.minerva.edu
- **Changelog**: [`CHANGELOG.md`](CHANGELOG.md)

---

**Built with ❤️ for the multi-agent AI community.**

