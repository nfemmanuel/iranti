# Quickstart — Get started with Iranti in 5 minutes

This guide gets you from zero to your first working Iranti deployment.

---

## Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org/)
- **Docker** — [Download here](https://www.docker.com/products/docker-desktop/)
- **Git** — [Download here](https://git-scm.com/)

---

## Step 1: Clone and Configure

```bash
git clone https://github.com/nfemmanuel/iranti
cd iranti
```

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Database (leave as-is for local development)
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/iranti
POSTGRES_PASSWORD=yourpassword

# LLM Provider (start with mock for testing)
LLM_PROVIDER=mock

# For production, use a real provider:
# LLM_PROVIDER=gemini
# GEMINI_API_KEY=your_key_here

# Optional runtime hygiene:
# IRANTI_ESCALATION_DIR=C:/Users/<you>/.iranti/escalation
# IRANTI_ARCHIVIST_WATCH=true
# IRANTI_ARCHIVIST_DEBOUNCE_MS=60000
# IRANTI_ARCHIVIST_INTERVAL_MS=21600000
```

---

## Step 2: Start the Database

```bash
docker-compose up -d
```

This starts a PostgreSQL container in the background. Verify it's running:

```bash
docker ps
```

You should see a container named `iranti-postgres-1` with status `Up`.

---

## Step 3: Install and Set Up

```bash
npm install
npm run setup
```

The setup script:
1. Runs database migrations
2. Generates the Prisma client
3. Seeds the Staff Namespace with operating rules
4. Pre-populates codebase knowledge
5. Creates escalation folders at `IRANTI_ESCALATION_DIR` (or `~/.iranti/escalation` by default)

You should see:

```
✓ Migrations applied
✓ Prisma client generated
✓ Staff Namespace seeded
✓ Codebase knowledge populated
✓ Escalation folders created
```

---

## Step 3.5: Optional Double-Layer Install Flow

Use this when you want one machine-level Iranti runtime and multiple per-project chatbot bindings.

### Install CLI

```bash
# Published package
npm install -g iranti

# Local simulation from this repo
npm install -g .
```

### Initialize runtime root + create an instance

```bash
iranti install --scope user
iranti instance create local --port 3001 --db-url "postgresql://postgres:yourpassword@localhost:5432/iranti_local"
iranti instance show local
```

Edit the printed instance `.env` and set real `DATABASE_URL` and `IRANTI_API_KEY`.

### Run instance

```bash
iranti run --instance local
```

### Bind a project

```bash
cd /path/to/chatbot-project
iranti project init . --instance local --agent-id chatbot_main
```

This writes `.env.iranti` with `IRANTI_URL`, `IRANTI_API_KEY`, and `IRANTI_AGENT_ID`.

---

## Step 4: Verify Installation

Run the integration test:

```bash
npm run test:integration
```

You should see all tests pass:

```
✓ Agent registration
✓ Write and query
✓ Conflict resolution
✓ Working memory handshake
✓ Relationships
✓ Maintenance cycle
```

---

Create a per-user API key token (recommended):

```bash
npm run api-key:create -- --key-id demo_user --owner "Demo User" --scopes memory,kb
```

Use the printed `keyId.secret` token in `X-Iranti-Key`.

## Your First Write

Create a file `test.ts`:

```typescript
import { Iranti } from './src/sdk';

async function main() {
    const iranti = new Iranti({
        connectionString: process.env.DATABASE_URL,
        llmProvider: 'mock',
    });

    // Write a fact
    const result = await iranti.write({
        entity: 'researcher/jane_smith',
        key: 'affiliation',
        value: { institution: 'MIT', department: 'CSAIL' },
        summary: 'Affiliated with MIT CSAIL',
        confidence: 85,
        source: 'OpenAlex',
        agent: 'my_agent',
    });

    console.log('Write result:', result);
    // { action: 'created', key: 'affiliation', reason: 'New entry created.' }
}

main();
```

Run it:

```bash
npx ts-node test.ts
```

---

## Your First Query

Add to `test.ts`:

```typescript
// Query the fact we just wrote
const query = await iranti.query('researcher/jane_smith', 'affiliation');

if (query.found) {
    console.log('Value:', query.value);
    console.log('Confidence:', query.confidence);
    console.log('Source:', query.source);
}
```

Output:

```
Value: { institution: 'MIT', department: 'CSAIL' }
Confidence: 85
Source: OpenAlex
```

---

## Your First Handshake

Working memory is what makes Iranti powerful. Before an agent starts a task, it calls `handshake()` to get a personalized brief:

```typescript
// Register an agent first
await iranti.registerAgent({
    agentId: 'research_agent_001',
    name: 'Research Agent',
    description: 'Scrapes academic databases',
    capabilities: ['web_scraping', 'data_extraction'],
    model: 'mock',
});

// Get working memory for a task
const brief = await iranti.handshake({
    agent: 'research_agent_001',
    task: 'Research publication history for Dr. Jane Smith',
    recentMessages: ['Starting literature review...'],
});

console.log('Task inferred:', brief.inferredTaskType);
console.log('Working memory entries:', brief.workingMemory.length);
console.log('Operating rules loaded:', brief.operatingRules.length > 0);
```

The Attendant:
1. Infers what type of task the agent is doing
2. Loads operating rules from the Staff Namespace
3. Filters the knowledge base for relevant entries
4. Returns a compact brief with only what's needed

Before each LLM response, use `attend()` so Attendant decides whether to inject memory for that turn:

```typescript
const turn = await iranti.attend({
    agent: 'research_agent_001',
    latestMessage: 'What is my favorite snack?',
    currentContext: 'User: What is my favorite snack?\nAssistant:',
    entityHints: ['user/main'],
    maxFacts: 5,
});

if (turn.shouldInject) {
    console.log('Inject these facts:', turn.facts.map((f) => f.summary));
}
```

---

## Ingest Raw Content

Instead of writing atomic facts manually, you can ingest raw text and let Iranti chunk it:

```typescript
const result = await iranti.ingest({
    entity: 'researcher/jane_smith',
    content: 'Dr. Jane Smith has 24 publications and previously worked at Google DeepMind from 2019 to 2022. Her research focuses on reinforcement learning and robotics.',
    source: 'OpenAlex',
    confidence: 80,
    agent: 'research_agent_001',
});

console.log('Facts written:', result.written);
console.log('Facts rejected:', result.rejected);
```

Iranti extracts atomic facts:
- `publication_count`: 24
- `previous_employer`: Google DeepMind (2019-2022)
- `research_focus`: reinforcement learning, robotics

---

## Connect Entities

Create relationships between entities:

```typescript
await iranti.relate(
    'researcher/jane_smith',
    'MEMBER_OF',
    'lab/mit_csail',
    { createdBy: 'research_agent_001' }
);

// Query relationships
const related = await iranti.getRelated('researcher/jane_smith');
console.log('Related entities:', related);
```

When you query `researcher/jane_smith`, Iranti automatically includes knowledge about `lab/mit_csail` in the working memory brief.

---

## What's Next?

- **[Python Client Guide](./python-client.md)** — Use Iranti from Python agents
- **[LLM Providers Guide](./providers.md)** — Switch from mock to real models
- **[Conflict Resolution Guide](./conflict-resolution.md)** — Understand how conflicts are handled
- **Run the demo**: `npm run demo` — See two agents with conflict resolution in action

---

## Common Issues

### Database connection fails

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution**: Make sure Docker is running and the database container is up:

```bash
docker-compose up -d
docker ps
```

### Prisma client not found

```
Error: Cannot find module '@prisma/client'
```

**Solution**: Run the setup script again:

```bash
npm run setup
```

### Port 5432 already in use

**Solution**: Stop any existing PostgreSQL instances or change the port in `docker-compose.yml`:

```yaml
ports:
  - "5433:5432"  # Use 5433 on host
```

Then update `DATABASE_URL` in `.env`:

```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5433/iranti
```

---

## Next Steps

You now have a working Iranti installation. Try:

1. **Write conflicting facts** — Write the same key twice with different values and see conflict resolution in action
2. **Check the archive** — Query the `archive` table to see full provenance
3. **Explore relationships** — Build a knowledge graph with `relate()` and `getRelatedDeep()`
4. **Run maintenance** — Call `runMaintenance()` to see the Archivist in action

See the [full SDK documentation](../../README.md#usage) for all available methods.
