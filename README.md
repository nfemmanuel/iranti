# Iranti

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)
[![Python](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![CrewAI Compatible](https://img.shields.io/badge/CrewAI-compatible-green.svg)](https://www.crewai.com/)

**Memory infrastructure for multi-agent AI systems.**

Iranti gives agents persistent, identity-based memory. Facts written by one agent are retrievable by any other agent through exact entity+key lookup. Iranti also supports hybrid search (lexical + vector) when exact keys are unknown. Memory persists across sessions and survives context window limits.

**Latest release:** [`v0.2.2`](https://github.com/nfemmanuel/iranti/releases/tag/v0.2.2)  
Published packages:
- `iranti@0.2.2`
- `@iranti/sdk@0.2.2`

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
- **Resolutionist**: Interactive CLI reviewer that guides humans through pending escalation files and writes valid authoritative resolutions.

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

### Conflict Benchmark Baseline

Iranti now also has an adversarial conflict benchmark that measures contradiction handling rather than basic retrieval.

| Suite | Score | Notes |
|---|---|---|
| **Direct contradiction** | `4/4` | Same entity+key conflicts are explicitly resolved or escalated |
| **Temporal conflict** | `4/4` | Equal-score ties now use deterministic temporal tie-breaks |
| **Cascading conflict** | `4/4` | Deterministic same-entity cross-key contradiction checks |
| **Multi-hop conflict** | `4/4` | Narrow relationship-aware contradiction checks across related entities |
| **Total** | `16/16 (100%)` | Current benchmark coverage for the Librarian |

Conflict benchmark methodology: [`docs/internal/conflict_benchmark.md`](docs/internal/conflict_benchmark.md)

### Consistency Validation

Iranti also now documents and validates its consistency model empirically:

| Check | Result |
|---|---|
| Concurrent write serialization | `PASS` |
| Read-after-write visibility | `PASS` |
| Escalation state integrity | `PASS` |
| Observe isolation from uncommitted writes | `PASS` |
| **Total** | `4/4` |

Consistency model and validation: [`docs/internal/consistency_model.md`](docs/internal/consistency_model.md)

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

## Gap Analysis

Iranti targets a specific gap in the agent infrastructure stack: most competing systems give you semantic retrieval, framework-specific memory, or raw vector storage, but not the same combination of structured fact storage, cross-agent sharing, identity-based lookup, explicit confidence, and developer-visible conflict handling in one self-hostable package.

The current competitive case for Iranti is strongest when a team needs memory that behaves more like shared infrastructure than a chat transcript: facts are attached to entities, retrieved deterministically by `entityType/entityId + key`, versioned over time, and made available across agents without framework lock-in.

### Where Iranti Is Differentiated

- Identity-first fact retrieval through `entityType/entityId + key`
- Cross-agent fact sharing as a first-class model
- Conflict-aware writes through the Librarian
- Explicit per-fact confidence scores
- Per-agent memory injection through the Attendant
- Temporal exact lookup with `asOf` and ordered `history()`
- Relationship primitives through `relate()`, `getRelated()`, and `getRelatedDeep()`
- Hybrid retrieval when exact keys are unknown
- Local install + project binding flow for Claude Code and Codex
- Published npm / PyPI surfaces with machine-level CLI setup

### Why That Gap Exists

The current landscape splits into three buckets:

1. **Memory libraries**
   - Systems like Mem0, Zep, Letta, and framework-native memory layers solve parts of the problem.
   - They usually optimize for semantic retrieval, agent-local memory, or framework integration.
   - They rarely expose deterministic `entity + key` lookup, explicit confidence surfaces, and developer-controlled conflict handling together.

2. **Vector databases**
   - Pinecone, Weaviate, Qdrant, Chroma, Milvus, LanceDB, and `pgvector` solve storage and retrieval infrastructure.
   - They do not, by themselves, solve memory semantics such as conflict resolution, context injection, fact lifecycle, or shared agent-facing state.

3. **Multi-agent frameworks**
   - CrewAI, LangGraph, AutoGen, CAMEL, MetaGPT, and similar frameworks often include some memory support.
   - In practice, that memory is usually framework-coupled, shallow on conflict semantics, and difficult to reuse outside the framework that created it.

### Main Gaps

1. **Operational maturity**
   - Local PostgreSQL setup is still a real source of friction.
   - The product needs stronger diagnostics, connection recovery, and less dependence on users debugging local database state by hand.

2. **Onboarding still has sharp edges**
   - `iranti setup` is materially better than before, but first-run still assumes too much infrastructure literacy.
   - Managed Postgres paths, cleaner bootstrap verification, and fewer environment-level surprises are still needed.

3. **No operator UI yet**
   - Iranti is still CLI-first.
   - There is no control plane yet for provider keys, project bindings, integrations, memory inspection, and escalation review.

4. **Adoption proof is still early**
   - The repo has validation experiments and real local end-to-end usage, but broad production adoption is still limited.
   - The next product truth has to come from external users and real workloads, not more speculative architecture alone.

5. **Hosted product is not built**
   - Open-source/local infrastructure is the active surface today.
   - Hosted deployment, multi-tenant operations, billing, and cloud onboarding remain future work.

6. **Graph-native reasoning is still limited**
   - Iranti supports explicit entity relationships today.
   - It does not yet compete with graph-first systems on temporal graph traversal or graph-native reasoning depth.

7. **Memory extraction is not the main model**
   - Iranti supports structured writes and ingest/chunking, but it is not primarily a "dump arbitrary conversations in and auto-magically derive perfect memory" system.
   - That is a deliberate tradeoff in favor of explicit, inspectable facts, but it increases integration work.

### Current Position

Iranti is strongest today as infrastructure for developers building multi-agent systems who need shared, structured, queryable memory rather than pure semantic recall. The current evidence base is now more concrete than a positioning claim alone:

- `16/16` fictional-fact transfer in retrieval validation
- `16/16 (100%)` on the current adversarial conflict benchmark
- `4/4` on empirical consistency validation for serialized writes and read visibility

That is not a claim that multi-agent memory is solved. It is a claim that Iranti now has reproducible evidence for three things at once:

- exact cross-agent fact transfer works
- same-key conflicting writes are serialized and observable
- conflict handling quality is measurable, including clearly documented failure modes

The next leverage is still product simplicity: setup, operations, and day-to-day inspection need to be simple enough that real users keep Iranti in the loop.

## Quickstart

**Requirements**: Node.js 18+, PostgreSQL, Python 3.8+

Docker is optional. It is one local way to run PostgreSQL if you do not already have a database.

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

# Optional: install the TypeScript client
npm install @iranti/sdk
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
Codex guide: [`docs/guides/codex.md`](docs/guides/codex.md)
Release guide: [`docs/guides/releasing.md`](docs/guides/releasing.md)
Vector backend guide: [`docs/guides/vector-backends.md`](docs/guides/vector-backends.md)

### Claude Code via MCP

Iranti ships a local stdio MCP server for Claude Code and other MCP clients:

```bash
iranti mcp
```

Use it with a project-local `.mcp.json`, and optionally add `iranti claude-hook` for `SessionStart` and `UserPromptSubmit`.

Guide: [`docs/guides/claude-code.md`](docs/guides/claude-code.md)

### Codex via MCP

Codex uses a global MCP registry rather than a project-local `.mcp.json`. Register Iranti once, then launch Codex in the bound project so `.env.iranti` is in scope:

```bash
iranti codex-setup
codex -C /path/to/your/project
```

When `iranti codex-setup` is run from a project directory, it automatically captures that project's `.env.iranti` as `IRANTI_PROJECT_ENV` so Codex resolves the correct Iranti instance consistently.

Guide: [`docs/guides/codex.md`](docs/guides/codex.md)

### Resolve Pending Escalations

Review unresolved human-escalation files from the CLI:

```bash
iranti resolve
```

Use `--dir` to point at a non-default escalation root. Guide: [`docs/guides/conflict-resolution.md`](docs/guides/conflict-resolution.md)

### Native Chat

Start a CLI chat session against the configured Iranti instance:

```bash
iranti chat
```

Use `--agent`, `--provider`, and `--model` to pin the session identity and model routing.
The chat surface now includes slash commands for fact history, relationships, conflict-resolution handoff, and confidence updates in addition to memory search/write operations.
Guide: [`docs/guides/chat.md`](docs/guides/chat.md)

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
iranti setup

# non-interactive automation
iranti setup --defaults --db-url "postgresql://postgres:realpassword@localhost:5432/iranti_local"
iranti setup --config ./iranti.setup.json

# or, if you want the lower-level manual path:
iranti install --scope user
```

`iranti setup` is the recommended first-run path. It walks through:
- shared vs isolated runtime setup
- instance creation or update
- API port selection with conflict detection and next-free suggestions
- database onboarding:
  - existing Postgres
  - managed Postgres
  - optional Docker-hosted Postgres for local development
- provider API keys
- Iranti client API key generation
- one or more project bindings
- optional Claude Code / Codex integration scaffolding

For automation:
- `iranti setup --defaults` uses sensible defaults plus environment/flag input, but still requires a real `DATABASE_URL`.
- `iranti setup --config <file>` reads a JSON setup plan for repeatable bootstrap.
- `--bootstrap-db` runs migrations and seeding during automated setup when the database is reachable.
- Example config: [docs/guides/iranti.setup.example.json](docs/guides/iranti.setup.example.json)

Default API port remains `3001`. The setup wizard now warns when that port is already in use and suggests the next free port instead of forcing users to debug the collision manually.

Defaults:
- Windows user scope: `%USERPROFILE%\\.iranti`
- Windows system scope: `%ProgramData%\\Iranti`
- Linux system scope: `/var/lib/iranti`
- macOS system scope: `/Library/Application Support/Iranti`

### 3) Create a named instance

```bash
iranti instance create local --port 3001 --db-url "postgresql://postgres:yourpassword@localhost:5432/iranti_local" --provider mock
iranti instance show local
```

Finish onboarding or change settings later with:

```bash
# Provider/db updates
iranti configure instance local --provider openai --provider-key sk-... --db-url "postgresql://postgres:realpassword@localhost:5432/iranti_local"
iranti configure instance local --interactive

# Provider key shortcuts
iranti list api-keys --instance local
iranti add api-key openai --instance local
iranti update api-key claude --instance local
iranti remove api-key gemini --instance local

# Create a registry-backed API key and sync it into the instance env
iranti auth create-key --instance local --key-id local_admin --owner "Local Admin" --scopes "kb:read,kb:write,memory:read,memory:write,agents:read,agents:write" --write-instance
```

`iranti add|update|remove api-key` updates the stored upstream provider credentials in the instance env without hand-editing `.env` files. `iranti list api-keys` shows which provider keys are currently stored. Supported remote providers are OpenAI, Claude, Gemini, Groq, and Mistral. `mock` and `ollama` do not require remote API keys, and Perplexity is not yet supported.

### 4) Run Iranti from that instance

```bash
iranti run --instance local
```

If a provider rejects requests because credits are exhausted, billing is disabled, or the account is quota-limited, Iranti now surfaces a direct message such as `OpenAI quota or billing limit reached. Add credits, update the API key, or switch providers.`

### 5) Bind any chatbot/app project to that instance

```bash
cd /path/to/your/chatbot
iranti project init . --instance local --agent-id chatbot_main
```

This writes `.env.iranti` in the project with the correct `IRANTI_URL`, `IRANTI_API_KEY`, and default agent identity.

Later changes use the same surface:

```bash
iranti configure project . --instance local --agent-id chatbot_worker
iranti configure project . --interactive
iranti auth create-key --instance local --key-id chatbot_worker --owner "Chatbot Worker" --scopes "kb:read,memory:read,memory:write" --project .
```

For multi-agent systems, bind once per project and set unique agent IDs per worker (for example `planner_agent`, `research_agent`, `critic_agent`).

### Installation Diagnostics

Use the CLI doctor command before first run or before a release check:

```bash
iranti doctor
iranti doctor --instance local
iranti status
iranti upgrade --check
iranti upgrade --dry-run
iranti upgrade --yes
```

This validates the active env file, database URL, API key presence, provider selection, and provider-specific credentials.
`iranti status` shows the current runtime root, known instances, and local binding files.
`iranti upgrade` detects repo/global/Python install paths, compares current vs latest published versions, prints the exact plan, and executes the selected upgrade path when you pass `--yes`.
`iranti configure ...` updates instance/project credentials without manual env editing.
`iranti auth ...` manages registry-backed API keys and can sync them into instance or project bindings.

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

### Graph Traversal

```python
from clients.python.iranti import IrantiClient

client = IrantiClient(base_url="http://localhost:3001", api_key="your_api_key_here")

# Agent 1 writes facts and links them into a graph.
client.write("researcher/jane_smith", "affiliation", {"lab": "CSAIL"}, "Jane Smith is affiliated with CSAIL", 90, "OpenAlex", "research_agent")
client.write("project/quantum_bridge", "status", {"phase": "active"}, "Quantum Bridge is active", 88, "project_brief", "research_agent")

client.relate("researcher/jane_smith", "MEMBER_OF", "lab/csail", created_by="research_agent")
client.relate("lab/csail", "LEADS", "project/quantum_bridge", created_by="research_agent")

# Agent 2 starts cold and traverses outward from Jane Smith.
one_hop = client.related("researcher/jane_smith")
labs = [f"{r['toType']}/{r['toId']}" for r in one_hop if r["relationshipType"] == "MEMBER_OF"]

projects = []
for lab in labs:
    for rel in client.related(lab):
        if rel["relationshipType"] == "LEADS":
            project = f"{rel['toType']}/{rel['toId']}"
            status = client.query(project, "status")
            projects.append((project, status.value["phase"]))

print(projects)
# Agent 2 learned which project Jane Smith is connected to without being told the project directly.
```

### Relationship Types

Relationship types are caller-defined strings. Common conventions:

| Relationship Type | Meaning |
|---|---|
| `MEMBER_OF` | Entity belongs to a team, lab, org, or group |
| `PART_OF` | Entity is a component or sub-unit of another entity |
| `AUTHORED` | Person or agent created a document, paper, or artifact |
| `LEADS` | Person, team, or org leads a project or effort |
| `DEPENDS_ON` | Project, service, or task depends on another entity |
| `REPORTS_TO` | Directed reporting relationship between people or agents |

Use uppercase snake case for consistency. Iranti does not enforce a fixed ontology here; the calling application owns the relationship vocabulary.

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

Iranti has five internal components:

| Component | Role |
|---|---|
| **Library** | PostgreSQL knowledge base. Current truth lives in `knowledge_base`; closed and contested intervals live in `archive`. |
| **Librarian** | Manages all writes. Detects conflicts, reasons about resolution, escalates when uncertain. |
| **Attendant** | Per-agent working memory manager. Implements `attend()`, `observe()`, and `handshake()` APIs. |
| **Archivist** | Periodic cleanup. Archives expired and low-confidence entries. Processes human-resolved conflicts. |
| **Resolutionist** | Interactive CLI helper that walks pending escalation files, writes `AUTHORITATIVE_JSON`, and marks them resolved for the Archivist. |

### REST API

Express server on port 3001 with endpoints:

- `POST /kb/write` - Write atomic fact
- `POST /kb/ingest` - Ingest raw text for one entity, auto-chunk into facts with per-fact confidence and per-fact write outcomes
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
knowledge_base          - current truth (one live row per entity/key)
archive                 - temporal and provenance history for superseded, contradicted, escalated, and expired rows
entity_relationships    - directional graph: MEMBER_OF, PART_OF, AUTHORED, etc.
entities                - canonical entity identity registry
entity_aliases          - normalized aliases mapped to canonical entities
write_receipts          - idempotency receipts for requestId replay safety
```

New entity types, relationship types, and fact keys do not require migrations; they are caller-defined strings.

**Archive semantics**: When a current fact is superseded or contested, the current row is removed from `knowledge_base` and a closed historical interval is written to `archive`. Temporal queries use `validFrom` / `validUntil` plus archive metadata to answer point-in-time reads.

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

