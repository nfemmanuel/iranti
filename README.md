# Iranti

**Agents forget everything. Iranti fixes that.**

When you build multi-agent systems, every agent starts blind. It has no memory of what other agents discovered yesterday, no way to know if a finding has already been contradicted, no awareness of what it should trust. Each session begins from zero.

Iranti is memory infrastructure for multi-agent AI systems. It gives agents shared, persistent, consistent knowledge — across sessions, across agents, across models. You plug it in underneath your existing agent system. It handles the rest.

---

## What It Does

Iranti maintains a knowledge base that any number of agents can read from and write to. It handles everything you don't want to build yourself:

- **Conflict resolution** — when two agents disagree on a fact, Iranti reasons about which source to trust, applies reliability history, and either resolves it automatically or escalates to a human-readable file for review
- **Working memory** — each agent gets a personalized brief at session start containing only what's relevant to its current task, not the entire knowledge base
- **Source reliability learning** — over time, Iranti learns which sources produce accurate findings and weights them accordingly
- **Knowledge relationships** — entities connect to each other; researching a person automatically surfaces knowledge about their lab, institution, and collaborators
- **Agent registry** — track which agents exist, what they've written, and who knows what about any given entity

---

## The Staff

Iranti has four internal components:

| Component | Role |
|---|---|
| **The Library** | PostgreSQL knowledge base. Active truth + full archive. Nothing is ever deleted. |
| **The Librarian** | Manages all writes. Detects conflicts, reasons about resolution, escalates when uncertain. |
| **The Attendant** | Per-agent working memory manager. Handshakes on startup, filters relevance, reconvenes when task shifts. |
| **The Archivist** | Periodic cleanup. Archives expired and low-confidence entries. Processes human-resolved conflicts. |

---

## Quickstart

**Requirements:** Node.js 18+, Docker

```bash
# 1. Clone and configure
git clone https://github.com/nfemmanuel/iranti
cd iranti
cp .env.example .env          # fill in your values

# 2. Start the database
docker-compose up -d

# 3. Install and set up
npm install
npm run setup                 # migrations + seed + codebase knowledge

# 4. Verify
npm run test:integration
```

---

## Usage

```typescript
import { Iranti } from './src/sdk';

const iranti = new Iranti({
    connectionString: process.env.DATABASE_URL,
    llmProvider: 'gemini',    // or 'claude', 'mock'
});

// Write a finding
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'MIT', department: 'CSAIL' },
    summary: 'Affiliated with MIT CSAIL',
    confidence: 85,
    source: 'OpenAlex',
    agent: 'research_agent_001',
});

// Ingest a raw text blob — Iranti chunks it into atomic facts
await iranti.ingest({
    entity: 'researcher/jane_smith',
    content: 'Dr. Jane Smith has 24 publications and previously worked at Google DeepMind from 2019 to 2022.',
    source: 'OpenAlex',
    confidence: 80,
    agent: 'research_agent_001',
});

// Get working memory before a task
const brief = await iranti.handshake({
    agent: 'research_agent_001',
    task: 'Research publication history for Dr. Jane Smith',
    recentMessages: ['Starting literature review...'],
});

// Query a specific fact
const result = await iranti.query('researcher/jane_smith', 'affiliation');

// Connect entities
await iranti.relate(
    'researcher/jane_smith',
    'MEMBER_OF',
    'lab/mit_csail',
    { createdBy: 'research_agent_001' }
);

// Find who knows what about an entity
const knowers = await iranti.whoKnows('researcher/jane_smith');
```

---

## Conflict Resolution

When two agents write conflicting facts about the same entity, the Librarian handles it automatically:

- **Confidence gap ≥ 10 points** → deterministic resolution, higher confidence wins
- **Confidence gap < 10 points** → LLM reasoning weighs source authority, recency, and reliability history
- **Genuinely ambiguous** → escalated to `escalation/active/` as a markdown file for human review

Escalation files are plain language. No code required to resolve them:

```markdown
**Status:** PENDING

## LIBRARIAN ASSESSMENT
Entity: researcher / jane_smith / affiliation
Existing: MIT (confidence: 75, source: OpenAlex)
Incoming: Harvard (confidence: 73, source: Wikipedia)
Reasoning: Sources have comparable authority for this fact type. Gap too small for deterministic resolution.

## HUMAN RESOLUTION
<!-- Write your resolution here, then change Status to RESOLVED -->
```

Change `PENDING` to `RESOLVED`, add your resolution in plain language. The Archivist picks it up on the next cycle and writes it to the knowledge base as authoritative truth.

---

## Source Reliability Learning

Iranti tracks which sources produce accurate findings over time. After every conflict resolution, the winning source's reliability score increases and the losing source's decreases. These scores are applied as weighted confidence on future writes:

```
weighted_confidence = raw_confidence × 0.7 + raw_confidence × reliability_score × 0.3
```

Unknown sources start at 0.5 (neutral). Scores range from 0.1 to 1.0. Scores decay slowly toward neutral so old patterns don't permanently dominate.

---

## LLM Configuration

Iranti routes different tasks to different models. You can configure each independently:

```env
LLM_PROVIDER=gemini           # gemini | claude | mock

# Per-task model overrides (optional)
CONFLICT_MODEL=gemini-2.5-pro          # needs careful reasoning
EXTRACTION_MODEL=gemini-2.0-flash-001  # structured output
TASK_INFERENCE_MODEL=gemini-2.0-flash-001
RELEVANCE_MODEL=gemini-2.0-flash-001
CLASSIFICATION_MODEL=gemini-2.0-flash-001
SUMMARIZATION_MODEL=gemini-2.0-flash-001
```

Use `LLM_PROVIDER=mock` for local development — no API key needed.

---

## Agent Registry

Register agents to track their activity:

```typescript
await iranti.registerAgent({
    agentId: 'research_agent_001',
    name: 'Research Agent',
    description: 'Scrapes academic databases for researcher profiles',
    capabilities: ['web_scraping', 'data_extraction'],
    model: 'gemini-2.0-flash-001',
});

// Stats update automatically on every write
const agent = await iranti.getAgent('research_agent_001');
console.log(agent.stats.totalWrites);       // 42
console.log(agent.stats.avgConfidence);     // 83

// Find who has knowledge about an entity
const knowers = await iranti.whoKnows('researcher/jane_smith');
// [{ agentId: 'research_agent_001', keys: ['affiliation', 'publication_count'], totalContributions: 2 }]
```

---

## Session Extractor

Iranti ships with a tool that extracts persistent facts from development conversations and writes them to the knowledge base. This is how we maintain context about Iranti's own development across sessions:

```bash
# From a file
npm run extract:session -- conversation.txt

# From stdin
npm run extract:session
```

Facts are stored under `codebase/iranti` and `session/YYYY-MM-DD` with full details in `valueRaw` and compressed summaries for fast working memory loading.

---

## Schema

Three tables. Nothing hardcoded.

```
knowledge_base          — active truth
archive                 — full provenance history, never deleted
entity_relationships    — directional graph: MEMBER_OF, PART_OF, AUTHORED, etc.
```

Every table has a `properties` JSON column for caller-defined metadata. New entity types, relationship types, and fact keys never require migrations — they are just strings you define.

---

## Project Structure

```
src/
├── library/            — DB client, queries, relationships, agent registry
├── librarian/          — Write logic, conflict resolution, chunking, reliability
├── attendant/          — Per-agent class, singleton registry, session persistence
├── archivist/          — Periodic cleanup, escalation processing
├── lib/                — LLM abstraction, model router, providers
└── sdk/                — Public API

scripts/
├── setup.ts            — Full onboarding (migrations, seed, codebase knowledge)
├── seed.ts             — Staff Namespace initialization
├── seed-codebase.ts    — Codebase knowledge pre-population
├── extract-session.ts  — Conversation → persistent facts
└── test-*.ts           — Component and integration tests

escalation/
├── active/             — Pending human review
├── resolved/           — Processed by Archivist
└── archived/           — Long-term conflict log
```

---

## Running Tests

```bash
npm run test:integration      # full end-to-end
npm run test:librarian        # conflict resolution
npm run test:attendant        # working memory
npm run test:reliability      # source scoring
npm run test:relationships    # knowledge graph
npm run test:registry         # agent tracking
npm run test:sdk              # public API
```

---

## License

AGPL-3.0 — free to self-host. If you offer Iranti as a hosted service, the source must remain open.

---

## Name

Iranti is the Yoruba word for memory and remembrance.
