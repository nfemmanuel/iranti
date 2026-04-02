# Troubleshooting Guide

Common issues and solutions for Iranti deployment and usage.

Use the current operator path first:

- `iranti status`
- `iranti doctor --instance <name>`
- `iranti instance show <name>`
- `iranti run --instance <name> --debug`

Some sections below still mention repo-checkout commands like `npm run api` because they remain useful when validating directly from source, but the primary runtime model is the instance-based CLI flow above.

---

## Installation Issues

### PostgreSQL Won't Start

**Symptom**: `docker-compose up -d` fails or PostgreSQL container exits

**Solutions**:
```bash
# Check if port 5432 is already in use
netstat -an | grep 5432  # Unix
netstat -an | findstr 5432  # Windows

# If port is taken, stop other PostgreSQL instance or change port in docker-compose.yml
# Then restart
docker-compose down
docker-compose up -d

# Check logs
docker-compose logs postgres
```

### npm install Fails

**Symptom**: Package installation errors

**Solutions**:
```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and package-lock.json
rm -rf node_modules package-lock.json
npm install

# Use specific Node version (18+)
nvm use 18
npm install
```

### Migration Fails

**Symptom**: `npm run setup` errors

**Solutions**:
```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Check DATABASE_URL in .env
cat .env | grep DATABASE_URL

# Manually run migrations
npm run migrate

# Reset database if needed (WARNING: deletes all data)
docker-compose down -v
docker-compose up -d
npm run setup
```

---

## API Server Issues

### Server Won't Start

**Symptom**: `npm run api` fails or exits immediately

**Solutions**:
```bash
# Check port 3001 is available
lsof -i :3001  # Unix
netstat -ano | findstr :3001  # Windows

# Check .env file exists and is valid
cat .env

# Check logs for specific error
npm run api 2>&1 | tee server.log

# Try different port
export IRANTI_PORT=3002
npm run api
```

### CLI Reports A File Lock Timeout

**Symptom**: A CLI command that mutates config or bindings fails with a lock timeout such as `Timed out waiting for file lock`.

**What it means**:
- another Iranti process is already updating the same env/config/runtime metadata file
- another Iranti process is scaffolding the same project files, such as `.env.iranti` or `.gitignore`
- or a previous process crashed and left a stale `.lock` file behind

**Solutions**:
```bash
# Inspect nearby lock files
# Windows
dir /s *.lock

# Unix
find . -name "*.lock"

# Retry after the other CLI process finishes
iranti status

# If the lock file is stale, remove only the matching lock file
# after confirming the owning process is gone.
```

Iranti now serializes env/config mutation with:
- lock file acquisition
- atomic temp write
- rename

So you should not work around this by running concurrent manual edits against the same binding or instance env file.

### Windows Upgrade Or Restart Looks Scheduled But Never Completes

**Symptom**: A Windows `upgrade` or `instance restart` path starts and then appears to stop making progress.

**What changed**:
- Iranti now prefers direct process invocation instead of `cmd.exe /c` string joins for lifecycle helpers.
- Detached Windows upgrade/restart paths resolve concrete executables and verify that replacement runtimes become healthy before reporting success.

**Solutions**:
```bash
iranti status --json
iranti doctor --instance <name>
```

If the detached path still fails, check:
- whether the resolved global `iranti` install still exists
- whether the instance env is complete
- whether the configured port is already occupied
- whether the replacement runtime can pass `/health`
- on Unix-like systems, whether a previously killed process is lingering as a zombie under another parent process; Iranti now treats zombie PIDs as exited, but the parent process still needs to reap them
- whether the instance `.env` actually contains `DATABASE_URL`; managed instance startup now treats the instance env as authoritative and will not silently borrow a parent-shell or CI `DATABASE_URL`

Important:
- `iranti upgrade --restart --instance <name>` only performs the restart during an executing upgrade path such as `--yes`
- without `--yes`, the command remains inspect-only and prints the plan instead of mutating anything

### Uninstall On Unix Terminates The Invoking Shell Or Test Harness

**Symptom**: A Unix-like `iranti uninstall --all --yes` ends with `Terminated` or appears to kill the process that launched it.

**What changed**:
- Iranti now excludes the current CLI process and its ancestor chain from uninstall process-stop scans.
- That prevents uninstall from classifying its own launcher (`npm`, `ts-node`, the current shell, or the test harness parent) as an Iranti runtime candidate.

If you still see this after upgrading, inspect `iranti uninstall --all --dry-run --json` and look for unexpected `process-scan` entries before running the destructive path.

### Uninstall Removed The Package But Left Runtime Data Behind

**Symptom**: `iranti uninstall --yes` removed the executable package surface, but the runtime root or `.env.iranti` files are still present.

**What it means**:
- this is the intended conservative default
- plain uninstall stops live Iranti processes and removes package installs, but preserves runtime data and project bindings

**Solutions**:
```bash
# Inspect the exact destructive plan first
iranti uninstall --all --dry-run --json

# Then remove runtime roots and project-local Iranti files
iranti uninstall --all --yes
```

### 401 Unauthorized Errors

**Symptom**: All API calls return 401

**Solutions**:
```bash
# Verify API key matches
# Server .env:
cat .env | grep IRANTI_API_KEY

# Client code:
echo $IRANTI_API_KEY  # If using env var

# Test with curl
curl -H "X-Iranti-Key: replace-with-real-iranti-key" http://localhost:3001/health

# Should return: {"status":"ok","version":"0.1.0","provider":"openai"}
```

### 500 Internal Server Errors

**Symptom**: API returns 500 errors

**Solutions**:
```bash
# Check server logs
npm run api

# Check PostgreSQL connection
psql $DATABASE_URL -c "SELECT 1"

# Check disk space
df -h

# Restart server
pkill -f "node.*api"
npm run api
```

### CLI Or MCP Fails With Missing Columns Or Tables

**Symptom**: A DB-backed command such as `iranti mcp`, `iranti handshake`, or `iranti attend` fails with an error mentioning a missing column or relation, for example `validFrom does not exist in the current database`.

**What it means**:
- the Iranti code and the connected PostgreSQL schema are out of sync
- the runtime is pointing at a database that has not had the current Prisma migrations applied

**Solutions**:
```bash
# Apply the shipped migrations to the connected database
npx prisma migrate deploy --schema prisma/schema.prisma

# Regenerate the Prisma client for the current checkout
npm run prisma:generate

# Then retry the command
iranti mcp --help
```

If this happens on a named instance, make sure you apply migrations to the database referenced by that instance's `DATABASE_URL`, not just the database in the current shell.

---

## Client Issues

### Python Client Import Errors

**Symptom**: `ModuleNotFoundError: No module named 'clients.python'`

**Solutions**:
```python
# Option 1: Add to path
import sys
sys.path.append('/path/to/iranti')
from clients.python.iranti import IrantiClient

# Option 2: Copy iranti.py to your project
# cp clients/python/iranti.py your_project/
from iranti import IrantiClient

# Option 3: Install as package (future)
# pip install iranti
```

### Connection Refused

**Symptom**: `requests.exceptions.ConnectionError: Connection refused`

**Solutions**:
```python
# Check server is running
import requests
response = requests.get('http://localhost:3001/health')
print(response.json())

# Check URL is correct
client = IrantiClient(
    base_url="http://localhost:3001",  # Not https, not port 3000
    api_key="your_key"
)

# Check firewall
# Allow port 3001 in firewall settings

# Check network
ping your-server-ip
```

### Facts Not Persisting

**Symptom**: Facts written but not retrieved

**Solutions**:
```python
# Check write response
result = client.write(...)
print(result.action)  # Should be 'created' or 'updated'
print(result.success)  # Should be True

# Verify fact exists
facts = client.query_all("your/entity")
print(len(facts))  # Should be > 0

# Check entity format
# Correct: "project/my_project"
# Wrong: "project-my_project" or "my_project"

# Check PostgreSQL directly
# psql $DATABASE_URL
# SELECT * FROM knowledge_base WHERE entity_type='project' AND entity_id='my_project';
```

---

## Agent Framework Issues

### CrewAI Tools Not Working

**Symptom**: Agents don't call Iranti tools

**Solutions**:
```python
# Ensure tools are properly decorated
from crewai.tools import tool

@tool("Tool name")  # Must have name
def my_tool(param: str) -> str:  # Must have type hints
    """Must have docstring"""  # Must have docstring
    return "result"

# Check tool is in agent's tools list
agent = Agent(
    role="...",
    tools=[my_tool],  # Must include tool
    llm=LLM(model="gpt-4o-mini")
)

# Enable verbose mode to see tool calls
crew = Crew(agents=[agent], tasks=[...], verbose=True)
```

### LangChain Import Errors

**Symptom**: `ImportError: cannot import name 'AgentExecutor'`

**Solutions**:
```bash
# Update LangChain
pip install --upgrade langchain langchain-openai langchain-core

# Use correct imports for your version
# LangChain 0.1.x:
from langchain.agents import AgentExecutor

# LangChain 0.2.x:
from langchain.agents import AgentExecutor
from langchain_core.tools import tool
```

### OpenAI API Errors

**Symptom**: `openai.error.AuthenticationError`

**Solutions**:
```bash
# Check API key is set
echo $OPENAI_API_KEY

# Set if missing
export OPENAI_API_KEY=replace-with-real-openai-key

# Check key is valid
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# Check you have credits
# Visit: https://platform.openai.com/account/usage
```

---

## Performance Issues

### Slow Query Responses

**Symptom**: API calls take >1 second

**Solutions**:
```bash
# Check PostgreSQL performance
psql $DATABASE_URL -c "EXPLAIN ANALYZE SELECT * FROM knowledge_base WHERE entity_type='project' LIMIT 10;"

# Add indexes if needed (already included in migrations)
psql $DATABASE_URL -c "CREATE INDEX IF NOT EXISTS idx_kb_entity ON knowledge_base(entity_type, entity_id);"

# Check database size
psql $DATABASE_URL -c "SELECT pg_size_pretty(pg_database_size('iranti'));"

# Vacuum database
psql $DATABASE_URL -c "VACUUM ANALYZE;"

# Check network latency
ping your-server-ip
```

### High Memory Usage

**Symptom**: Server uses >1GB RAM

**Solutions**:
```bash
# Check Node.js memory
ps aux | grep node

# Increase Node.js memory limit if needed
export NODE_OPTIONS="--max-old-space-size=2048"
npm run api

# Check PostgreSQL memory
docker stats postgres

# Reduce PostgreSQL connections in .env
# Add to DATABASE_URL: ?max_connections=10
```

### Database Growing Too Large

**Symptom**: PostgreSQL using >10GB disk space

**Solutions**:
```bash
# Check table sizes
psql $DATABASE_URL -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) FROM pg_tables WHERE schemaname='public' ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"

# Archive old facts (future feature)
# For now, manually delete old entries
psql $DATABASE_URL -c "DELETE FROM archive WHERE created_at < NOW() - INTERVAL '1 year';"

# Vacuum to reclaim space
psql $DATABASE_URL -c "VACUUM FULL;"
```

---

## Data Issues

### Conflict Resolution Not Working

**Symptom**: Conflicts not detected or resolved

**Solutions**:
```python
# Check confidence scores are different
result1 = client.write(entity="test/entity", key="fact", value={"data": "A"}, confidence=80, ...)
result2 = client.write(entity="test/entity", key="fact", value={"data": "B"}, confidence=90, ...)

# Higher confidence should win
fact = client.query("test/entity", "fact")
print(fact.value)  # Should be {"data": "B"}

# Check escalation threshold (default: 10 points)
# If confidence difference < 10, conflict escalates
result3 = client.write(entity="test/entity", key="fact", value={"data": "C"}, confidence=85, ...)
print(result3.action)  # Should be 'escalated'
```

### Facts Disappearing

**Symptom**: Facts written but later missing

**Solutions**:
```bash
# Check archive table (facts never deleted, only archived)
psql $DATABASE_URL -c "SELECT * FROM archive WHERE entity_type='your_type' AND entity_id='your_id';"

# Check if facts were overwritten
psql $DATABASE_URL -c "SELECT * FROM archive WHERE entity_type='your_type' AND entity_id='your_id' AND key='your_key' ORDER BY created_at DESC;"

# Restore from archive if needed
psql $DATABASE_URL -c "INSERT INTO knowledge_base SELECT * FROM archive WHERE id='fact_id';"
```

### Vector Search Looks Stale Or Returns Deleted Facts

**Symptom**:
- hybrid search misses facts that exact lookup can still find
- vector search returns deleted facts
- search quality drops after vector backend outages

**What it means**:
- `knowledge_base` and the configured vector backend have drifted
- the usual causes are missing embeddings or orphaned backend vectors
- `iranti doctor` does not detect this yet; use the library reconciliation helpers below

**Recovery path**:
Run the reconciliation helpers from the repo root:

```ts
import { auditVectorIndexConsistency, repairVectorIndexConsistency } from './src/library/queries';

const audit = await auditVectorIndexConsistency();
console.log(audit);

if (!audit.consistent) {
  const repaired = await repairVectorIndexConsistency();
  console.log(repaired);
}
```

Interpretation:
- `missingEntryIds`: facts exist in `knowledge_base` but are absent from the vector backend
- `orphanedVectorIds`: vectors exist in the backend for facts that no longer exist in `knowledge_base`
- `consistent: true`: the KB and vector backend are aligned

Current 0.2.x note:
- drift detection and repair exist in the library helper surface now
- the natural CLI hook is `iranti doctor`, but that wiring is intentionally left for a separate patch

### Unicode/Emoji Issues

**Symptom**: Facts with emoji or special characters fail

**Solutions**:
```python
# Ensure UTF-8 encoding
client.write(
    entity="project/test",
    key="emoji",
    value={"text": "Hello 👋 World 🌍"},
    summary="Emoji test",
    confidence=90,
    source="test",
    agent="test"
)

# Check PostgreSQL encoding
# psql $DATABASE_URL -c "SHOW SERVER_ENCODING;"
# Should be UTF8

# If not, recreate database with UTF8
# createdb -E UTF8 iranti
```

---

## Browser Extension Issues

### Extension Not Loading

**Symptom**: No console messages in browser

**Solutions**:
```bash
# Check extension is enabled
# chrome://extensions/ → Iranti Memory should be ON

# Check Developer mode is enabled
# chrome://extensions/ → Toggle "Developer mode" ON

# Reload extension
# chrome://extensions/ → Click reload icon

# Check for errors
# chrome://extensions/ → Click "Errors" button
```

### CSP Errors

**Symptom**: "Content Security Policy" errors in console

**Solutions**:
```
# This is expected for ChatGPT and Claude
# Browser extensions are blocked by CSP
# Use API middleware instead (see clients/middleware/iranti_middleware.py)

# Or use bookmarklet approach (see clients/middleware/iranti-extension/BOOKMARKLET.md)
```

### Facts Not Injecting

**Symptom**: Extension loads but facts don't appear in chat

**Solutions**:
```javascript
# Check console for Iranti messages
// Should see:
// [Iranti Extension] Loaded on chat.openai.com
// [Iranti Extension] Calling observe()...
// [Iranti Extension] Injected X facts

# If no messages, check content.js is running
console.log('[Test] Extension loaded');

# Check IRANTI_URL and API_KEY are correct
const IRANTI_URL = 'http://localhost:3001';  // Must match server
const IRANTI_API_KEY = 'replace-with-real-iranti-key';  // Must match .env

# Test observe() manually
fetch('http://localhost:3001/memory/observe', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Iranti-Key': 'replace-with-real-iranti-key'
  },
  body: JSON.stringify({
    agentId: 'test',
    currentContext: 'test context',
    maxFacts: 5
  })
}).then(r => r.json()).then(console.log);
```

---

## Getting Help

If you're still stuck:

1. **Check logs**: `npm run api` output shows detailed errors
2. **Check database**: `psql $DATABASE_URL` to inspect data directly
3. **Test with curl**: Isolate whether issue is client or server
4. **Enable debug mode**: Set `DEBUG=*` environment variable
5. **Open GitHub issue**: https://github.com/nfemmanuel/iranti/issues
6. **Email**: oluwaniifemi.emmanuel@uni.minerva.edu

Include in your report:
- Error message (full stack trace)
- Steps to reproduce
- Environment (OS, Node version, Python version)
- Relevant code snippet
- Server logs

