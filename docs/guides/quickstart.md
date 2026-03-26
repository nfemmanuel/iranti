# Quickstart — Get started with Iranti in 5 minutes

This guide gets you from zero to your first working Iranti deployment.

---

## Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org/)
- **PostgreSQL** — local or managed
- **Docker** — optional, only if you want local PostgreSQL via containers
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
# POSTGRES_PASSWORD is optional for local dev; Iranti setup defaults it to "postgres"
# when you leave the Docker PostgreSQL password blank.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti
POSTGRES_PASSWORD=postgres

# LLM Provider (start with mock for testing)
LLM_PROVIDER=mock

# For production, use a real provider:
# LLM_PROVIDER=gemini
# GEMINI_API_KEY=replace-with-real-gemini-key

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

### Recommended first-run setup

```bash
iranti setup

# automation-friendly variants
iranti setup --defaults --db-url "postgresql://postgres:realpassword@localhost:5432/iranti_local"
iranti setup --config ./iranti.setup.json
```

`iranti setup` is the preferred onboarding path for new users. It keeps prompting until the runtime, instance, provider credentials, Iranti client key, and optional project bindings are configured. It also lets you choose between:
- an isolated per-project runtime folder (default and recommended)
- a shared machine-level runtime when you explicitly want multiple projects to share one instance
- local, managed, or Docker-hosted PostgreSQL

The setup wizard also checks whether the default API port (`3001`) is already occupied and suggests the next free port instead of failing late.
It now also prints a dependency preflight up front so you can see whether Docker, `psql`, `pg_isready`, or a local PostgreSQL listener on `localhost:5432` are available before going deeper into database setup. If Docker is available, setup now prefers that path because it guarantees pgvector. If local PostgreSQL is reachable, setup can still use it, but bootstrap now fails early unless that server actually provides pgvector. If neither local pgvector nor Docker is available, setup stays on PostgreSQL and steers you toward a managed connection plus concrete install guidance for local tooling.

Automation notes:
- `--defaults` skips prompts and uses defaults plus environment/flag input. It now derives a localhost or Docker `DATABASE_URL` automatically when `--db-mode local` or `--db-mode docker` is selected. A real `--db-url` is still required for `--db-mode managed`.
- `--config` accepts a JSON setup plan for repeatable bootstrap in CI or managed installs.
- `--bootstrap-db` runs migrations and seeding during automated setup when the target database is reachable and suitable for Prisma bootstrap.
- Example config: [`iranti.setup.example.json`](./iranti.setup.example.json)

`--bootstrap-db` is for a fresh or already-compatible pgvector-enabled PostgreSQL database. If your target database is already populated but not Prisma-baselined, or the server does not have `pgvector` installed, run setup without `--bootstrap-db` and bootstrap the database separately.

Manual commands are still available below when you want full low-level control.
If you are unsure which low-level command to use, `iranti <command> --help` now includes a short summary of what it does and when to use it.

### Initialize runtime root + create an instance

```bash
iranti install --scope user
iranti instance create local --port 3001 --db-url "postgresql://postgres:yourpassword@localhost:5432/iranti_local" --provider mock
iranti instance show local
```

That path is still supported, but it is the lower-level plumbing path now. New users should prefer `iranti setup`, which defaults to isolated per-project installs and writes `IRANTI_PROJECT_MODE=isolated` into project bindings.

Finish setup without hand-editing the env file:

```bash
# Switch to a real provider later if needed
iranti configure instance local --provider openai --provider-key replace-with-real-openai-key --db-url "postgresql://postgres:realpassword@localhost:5432/iranti_local"
iranti configure instance local --interactive

# Manage provider keys directly
iranti list api-keys --instance local
iranti add api-key openai --instance local
iranti update api-key claude --instance local
iranti remove api-key gemini --instance local

# Create a real Iranti API key and sync it into the instance env
iranti auth create-key --instance local --key-id local_admin --owner "Local Admin" --scopes "kb:read,kb:write,memory:read,memory:write,agents:read,agents:write" --write-instance
```

### Run instance

```bash
iranti run --instance local
```

The running API now records runtime metadata and exposes it through both `/health` and the CLI:

```bash
iranti status
iranti instance show local
iranti upgrade --check
```

If you install a newer CLI/runtime and want the instance-backed API server to pick it up immediately:

```bash
iranti upgrade --yes --restart --instance local
```

`--restart` is only executed during a real upgrade run. If you omit `--yes`, Iranti stays in inspect/dry-run mode and prints the plan without restarting anything.

### Check configuration before run

```bash
  iranti doctor --instance local
  iranti status
  iranti upgrade --check
  ```

Use `iranti configure instance ...` when you want to edit several instance fields together. Use `iranti add|update|remove api-key` when you only want to manage upstream provider credentials without opening the env file manually. Supported remote providers are OpenAI, Claude, Gemini, Groq, and Mistral. `mock` and `ollama` do not require remote API keys, and Perplexity is not yet supported.

If a remote provider runs out of credits or hits a billing quota, Iranti surfaces a direct provider warning instead of a generic failure. Example: `Claude quota or billing limit reached. Add credits, update the API key, or switch providers.`

### Bind a project

```bash
cd /path/to/chatbot-project
iranti project init . --instance local --agent-id chatbot_main
```

This writes `.env.iranti` with `IRANTI_URL`, `IRANTI_API_KEY`, `IRANTI_AGENT_ID`, `IRANTI_MEMORY_ENTITY`, `IRANTI_PERSONAL_MEMORY_ENTITY`, `IRANTI_AUTO_REMEMBER`, and `IRANTI_PROJECT_MODE`.

Default manual binding mode is `isolated`. If you intentionally want a project to share memory with another project on the same instance, make that explicit:

```bash
iranti project init . --instance shared_team --agent-id chatbot_main --mode shared
```

If you want strict prompt/summary auto-remember from the start, make that explicit at bind time:

```bash
iranti project init . --instance local --agent-id chatbot_main --auto-remember
```

To rotate a bound project key later:

```bash
iranti auth create-key --instance local --key-id chatbot_main --owner "Chatbot Main" --scopes "kb:read,memory:read,memory:write" --project .
```

To change the project agent identity or rebind to another instance:

```bash
iranti configure project . --instance local --agent-id chatbot_worker
iranti configure project . --auto-remember true
iranti configure project . --mode shared
iranti configure project . --interactive
```

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

For a quick environment check before that, run:

```bash
  iranti doctor
  iranti status
  iranti upgrade --check
  ```

---

Create a per-user API key token (recommended):

```bash
iranti auth create-key --instance local --key-id demo_user --owner "Demo User" --scopes "kb:read,kb:write,memory:read,memory:write,agents:read,agents:write"
```

Use the printed `keyId.secret` token in `X-Iranti-Key`.
Scope format is `resource:action` or `resource:action:entityType/entityId` (for example `kb:read`, `memory:write`, `kb:write:project/*`).

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

## Hybrid Search (Lexical + Vector)

Use hybrid search when you do not know the exact key ahead of time:

```typescript
const matches = await iranti.search({
    query: 'current project blocker',
    entityType: 'project',
    limit: 5,
    lexicalWeight: 0.45,
    vectorWeight: 0.55,
});

for (const match of matches) {
    console.log(match.entity, match.key, match.score);
}
```

This combines full-text relevance with embedding similarity and returns ranked facts.

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
    agentId: 'research_agent_001',
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
    agentId: 'research_agent_001',
    latestMessage: 'What is my favorite snack?',
    currentContext: 'User: What is my favorite snack?\nAssistant:',
    entityHints: ['user/main'],
    maxFacts: 5,
});

if (turn.shouldInject) {
    console.log('Inject these facts:', turn.facts.map((f) => f.summary));
}
```

For longer tasks, checkpoint the current step so the next handshake can recommend resuming interrupted work:

```typescript
await iranti.checkpoint({
    agentId: 'research_agent_001',
    task: 'Research publication history for Dr. Jane Smith',
    recentMessages: ['Still comparing affiliation sources.'],
    checkpoint: {
        currentStep: 'Resolve source disagreement',
        nextStep: 'Write corrected affiliation fact',
        openRisks: ['OpenAlex and homepage disagree on date range'],
    },
});

// Later, after the process dies or the agent comes back:
const recovered = await iranti.handshake({
    agentId: 'research_agent_001',
    task: 'Research publication history for Dr. Jane Smith',
    recentMessages: ['Returning to the affiliation investigation.'],
});

if (recovered.sessionRecovery?.available && recovered.sessionRecovery.recommendation === 'resume') {
    await iranti.resumeSession({
        agentId: 'research_agent_001',
        sessionId: recovered.sessionRecovery.sessionId,
    });
}

const sessions = await iranti.listSessions({ operatorState: 'interrupted', sort: 'operator' });
console.log(sessions.map((session) => `${session.agentId}: ${session.operatorState}`));

const inspection = await iranti.inspectSession({
    agentId: 'research_agent_001',
    task: 'Research publication history for Dr. Jane Smith',
    recentMessages: ['Still comparing affiliation sources.'],
});

console.log(inspection.summary.operatorState);
console.log(inspection.sessionRecovery?.recommendation ?? 'no recovery recommendation');
```

`inspectSession()` gives you both the raw persisted checkpoint and the operator-facing summary. A stale checkpoint can still have `sessionCheckpoint.status = 'active'` while `summary.operatorState = 'interrupted'`. `listSessions()` is the inventory view; `inspectSession()` is the one-agent drill-down.
`checkpoint()` itself stores progress and clears any existing recovery recommendation. Recovery advice appears later on `handshake()` or `inspectSession(...)` when Iranti evaluates a returning task against the persisted checkpoint.

For Claude Code to hand work over to Codex, write the durable handoff into a shared `task/...` entity and keep any sender-local recovery in a normal checkpoint:

```typescript
await iranti.write({
    entity: 'task/runtime_verification_pass',
    key: 'status',
    value: { state: 'ready_for_codex' },
    summary: 'Shared task is ready for Codex pickup.',
    confidence: 96,
    source: 'ClaudeCode',
    agent: 'claude_code_main',
});

await iranti.write({
    entity: 'task/runtime_verification_pass',
    key: 'next_step',
    value: { instruction: 'Implement the CLI runtime verification pass.' },
    summary: 'Next step is to implement the CLI runtime verification pass.',
    confidence: 95,
    source: 'ClaudeCode',
    agent: 'claude_code_main',
});
```

The CLI now exposes the same shared-memory pattern directly:

```bash
iranti handoff task/runtime_verification_pass \
  --agent claude_code_main \
  --owner codex_code_main \
  --status ready_for_codex \
  --next-step "Implement the CLI runtime verification pass." \
  --blockers "Preserve compatibility docs." \
  --artifacts "docs/guides/codex.md||docs/guides/claude-code.md"
```

Use `iranti handoff` for the shared task state and `checkpoint()` for the sender's own recovery state. For the full pattern, see [Cross-Tool Handoffs](./cross-tool-handoffs.md).

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

