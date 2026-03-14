# Python Client Guide — Use Iranti from Python agents

Complete guide to using the Iranti Python client with any Python agent framework.

---

## Installation

Install from PyPI:

```bash
pip install iranti
```

For local development from this repository:

```bash
cd clients/python
pip install -e .
```

---

## Setup

### Start the Iranti API Server

The Python client connects to the Iranti REST API. Start the server first:

```bash
# In the iranti directory
npm run api
```

You should see:

```
Iranti API running on port 3001
Health: http://localhost:3001/health
Provider: mock
```

### Configure Environment Variables

Set these in your environment or `.env` file:

```bash
export IRANTI_URL=http://localhost:3001
export IRANTI_API_KEY=your_api_key_here
```

`IRANTI_API_KEY` can be either:
- a registry token (`keyId.secret`, recommended), or
- the legacy shared key from server `.env`.

---

## Basic Usage

```python
from iranti import IrantiClient

# Initialize client
client = IrantiClient(
    base_url="http://localhost:3001",
    api_key="your_api_key_here"
)

# Or use environment variables
client = IrantiClient()  # Reads IRANTI_URL and IRANTI_API_KEY

# Check server is running
health = client.health()
print(health)  # {'status': 'ok', 'version': '0.1.0', 'provider': 'mock'}
```

---

## Writing Facts

### Write an Atomic Fact

```python
result = client.write(
    entity="researcher/jane_smith",
    key="affiliation",
    value={"institution": "MIT", "department": "CSAIL"},
    summary="Affiliated with MIT CSAIL",
    confidence=85,
    source="OpenAlex",
    agent="my_agent"
)

print(result.action)   # 'created' | 'updated' | 'rejected' | 'escalated'
print(result.key)      # 'affiliation'
print(result.reason)   # 'New entry created.'
```

**Parameters:**
- `entity` (str): Entity in format `"entityType/entityId"`
- `key` (str): Fact key, e.g. `"affiliation"`, `"publication_count"`
- `value` (Any): Full fact value (any JSON-serializable object)
- `summary` (str): One-sentence summary for working memory
- `confidence` (int): 0-100
- `source` (str): Data source name
- `agent` (str): Agent ID writing this fact
- `valid_from` (str, optional): ISO datetime string for when the fact became true/current

**Returns:** `WriteResult` with `action`, `key`, `reason`

### Ingest Raw Content

Let Iranti extract atomic facts from raw text:

```python
result = client.ingest(
    entity="researcher/jane_smith",
    content="Dr. Jane Smith has 24 publications and previously worked at Google DeepMind from 2019 to 2022.",
    source="OpenAlex",
    confidence=80,
    agent="my_agent"
)

print(f"Written: {result.written}, Rejected: {result.rejected}")
print(f"Facts: {result.facts}")
```

**Returns:** `IngestResult` with:
- `written` (int): Number of facts successfully written
- `rejected` (int): Number of facts rejected
- `escalated` (int): Number of facts escalated
- `facts` (list): List of `WriteResult` objects

---

## Querying Facts

### Query a Specific Fact

```python
result = client.query("researcher/jane_smith", "affiliation")

if result.found:
    print(result.value)       # {'institution': 'MIT', 'department': 'CSAIL'}
    print(result.summary)     # 'Affiliated with MIT CSAIL'
    print(result.confidence)  # 85
    print(result.source)      # 'OpenAlex'
else:
    print("Fact not found")
```

**Returns:** `QueryResult` with:
- `found` (bool): Whether the fact exists
- `value` (Any): Full fact value
- `summary` (str): One-sentence summary
- `confidence` (int): 0-100
- `source` (str): Data source
- `valid_from` (str): Start of the current or historical interval
- `valid_until` (str | None): End of the interval (`None` for current rows)

### Query All Facts for an Entity

```python
facts = client.query_all("researcher/jane_smith")

for fact in facts:
    print(f"{fact['key']}: {fact['summary']} (confidence: {fact['confidence']})")
```

**Returns:** List of dicts with `key`, `value`, `summary`, `confidence`, `source`

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

**Returns:** Ranked list of matching facts with `lexicalScore`, `vectorScore`, and `score`.

---

## Working Memory

### Handshake (Start Session)

Before an agent starts a task, call `handshake()` to get a working memory brief:

```python
brief = client.handshake(
    agent="my_agent",
    task="Research publication history for Dr. Jane Smith",
    recent_messages=["Starting literature review..."]
)

print(f"Task inferred: {brief.inferred_task_type}")
print(f"Working memory entries: {len(brief.working_memory)}")
print(f"Operating rules: {brief.operating_rules[:100]}...")

for entry in brief.working_memory:
    print(f"  {entry.entity_key}: {entry.summary}")
```

**Returns:** `WorkingMemoryBrief` with:
- `agent_id` (str): Agent ID
- `operating_rules` (str): Rules loaded from Staff Namespace
- `inferred_task_type` (str): What the agent is doing
- `working_memory` (list): Relevant knowledge entries
- `session_started` (str): ISO datetime
- `brief_generated_at` (str): ISO datetime
- `context_call_count` (int): Number of LLM calls made

### Reconvene (Update Session)

If the agent's task shifts, call `reconvene()` to update working memory:

```python
brief = client.reconvene(
    agent_id="my_agent",
    task="Now analyzing citation patterns",
    recent_messages=["Switching to citation analysis..."]
)
```

**Returns:** Updated `WorkingMemoryBrief`

### Attend (Per-Turn Memory Decision)

Before each LLM turn, call `attend()` so Attendant decides whether memory is needed:

```python
turn = client.attend(
    agent_id="my_agent",
    latest_message="What is my favorite snack?",
    current_context="User: What is my favorite snack?\nAssistant:",
    entity_hints=["user/main"],
    max_facts=5
)

if turn["shouldInject"]:
    for fact in turn["facts"]:
        print(f"Inject: {fact['summary']}")
```

**Returns:** dict with:
- `shouldInject` (bool): whether to inject facts now
- `reason` (str): decision reason (`memory_not_needed`, `memory_needed_injected`, etc.)
- `decision` (dict): Attendant decision metadata (`needed`, `confidence`, `method`, `explanation`)
- `facts` (list): facts to inject when needed

### Who Knows What

Find all agents that have written facts about an entity:

```python
knowers = client.who_knows("researcher/jane_smith")

for k in knowers:
    print(f"{k['agentId']}: {k['keys']} ({k['totalContributions']} facts)")
```

**Returns:** List of dicts with `agentId`, `keys`, `totalContributions`

---

## Relationships

### Create a Relationship

```python
client.relate(
    from_entity="researcher/jane_smith",
    relationship_type="MEMBER_OF",
    to_entity="lab/mit_csail",
    created_by="my_agent",
    properties={"since": "2020"}
)
```

Relationships are directional. `jane_smith MEMBER_OF mit_csail` is different from `mit_csail MEMBER_OF jane_smith`.

### Get Related Entities (1 Hop)

```python
related = client.get_related("researcher/jane_smith")

for r in related:
    print(f"{r['relationshipType']}: {r['toType']}/{r['toId']}")
```

`client.related(...)` is an alias for `client.get_related(...)`.

### Get Related Entities (Deep Traversal)

```python
related = client.get_related_deep("researcher/jane_smith", depth=3)

# Returns entities up to 3 hops away
```

`client.related_deep(...)` is an alias for `client.get_related_deep(...)`.

---

## Agent Registry

### Register an Agent

```python
client.register_agent(
    agent_id="my_agent",
    name="Research Agent",
    description="Scrapes academic databases for researcher profiles",
    capabilities=["web_scraping", "data_extraction"],
    model="gpt-4o-mini",
    properties={"version": "1.0"}
)
```

### Get Agent Details

```python
agent = client.get_agent("my_agent")

if agent:
    print(f"Name: {agent.profile['name']}")
    print(f"Total writes: {agent.stats.total_writes}")
    print(f"Avg confidence: {agent.stats.avg_confidence}")
    print(f"Last seen: {agent.stats.last_seen}")
else:
    print("Agent not found")
```

**Returns:** `AgentRecord` with `profile` dict and `stats` object

### List All Agents

```python
agents = client.list_agents()

for agent in agents:
    print(f"{agent['agentId']}: {agent['name']}")
```

### Assign to Team

```python
client.assign_to_team("my_agent", "research_team_alpha")
```

---

## Maintenance

Run the Archivist maintenance cycle:

```python
report = client.run_maintenance()

print(f"Expired archived: {report.expired_archived}")
print(f"Low confidence archived: {report.low_confidence_archived}")
print(f"Escalations processed: {report.escalations_processed}")
print(f"Errors: {report.errors}")
```

**Returns:** `MaintenanceReport` with counts and error list

---

## Error Handling

The client raises specific exceptions for different error types:

```python
from iranti import (
    IrantiClient,
    IrantiError,
    IrantiAuthError,
    IrantiValidationError,
    IrantiNotFoundError
)

try:
    result = client.write(
        entity="researcher/jane_smith",
        key="affiliation",
        value={"institution": "MIT"},
        summary="Affiliated with MIT",
        confidence=85,
        source="OpenAlex",
        agent="my_agent"
    )
except IrantiAuthError:
    print("Invalid API key")
except IrantiValidationError as e:
    print(f"Bad input: {e}")
except IrantiNotFoundError as e:
    print(f"Not found: {e}")
except IrantiError as e:
    print(f"API error: {e}")
```

**Exception Hierarchy:**
- `IrantiError` — Base exception
  - `IrantiAuthError` — 401 Unauthorized
  - `IrantiValidationError` — 400 Bad Request
  - `IrantiNotFoundError` — 404 Not Found

---

## Using with CrewAI

Integrate Iranti with CrewAI agents:

```python
from crewai import Agent, Task, Crew
from iranti import IrantiClient

# Initialize Iranti
iranti = IrantiClient()

# Register agent
iranti.register_agent(
    agent_id="researcher_agent",
    name="Researcher Agent",
    description="Researches academic profiles",
    capabilities=["web_scraping", "data_extraction"],
    model="gpt-4o-mini"
)

# Create CrewAI agent
researcher = Agent(
    role="Research Specialist",
    goal="Research academic profiles and publications",
    backstory="Expert at finding and analyzing academic data",
    verbose=True
)

# Before task execution, get working memory
brief = iranti.handshake(
    agent="researcher_agent",
    task="Research Dr. Jane Smith's publication history",
    recent_messages=["Starting research task..."]
)

# Add working memory to agent context
context = f"""
Operating Rules:
{brief.operating_rules}

Relevant Knowledge:
{chr(10).join(f"- {e.entity_key}: {e.summary}" for e in brief.working_memory)}
"""

# Create task with context
task = Task(
    description=f"{context}\n\nResearch Dr. Jane Smith's publication history",
    agent=researcher
)

# After task execution, write findings
iranti.write(
    entity="researcher/jane_smith",
    key="publication_count",
    value={"count": 24},
    summary="Has published 24 papers",
    confidence=90,
    source="OpenAlex",
    agent="researcher_agent"
)
```

---

## Using with LangChain

Integrate Iranti with LangChain agents:

```python
from langchain.agents import initialize_agent, Tool
from langchain.llms import OpenAI
from iranti import IrantiClient

iranti = IrantiClient()

# Create tools that use Iranti
def write_fact(input_str: str) -> str:
    """Write a fact to Iranti. Format: entity|key|value|summary|confidence|source"""
    parts = input_str.split('|')
    result = iranti.write(
        entity=parts[0],
        key=parts[1],
        value={"value": parts[2]},
        summary=parts[3],
        confidence=int(parts[4]),
        source=parts[5],
        agent="langchain_agent"
    )
    return f"Wrote {result.key}: {result.action}"

def query_fact(input_str: str) -> str:
    """Query a fact from Iranti. Format: entity|key"""
    entity, key = input_str.split('|')
    result = iranti.query(entity, key)
    if result.found:
        return f"{result.summary} (confidence: {result.confidence})"
    return "Fact not found"

tools = [
    Tool(name="WriteFact", func=write_fact, description="Write a fact to memory"),
    Tool(name="QueryFact", func=query_fact, description="Query a fact from memory"),
]

llm = OpenAI(temperature=0)
agent = initialize_agent(tools, llm, agent="zero-shot-react-description", verbose=True)

# Get working memory before execution
brief = iranti.handshake(
    agent="langchain_agent",
    task="Research and store academic profiles",
    recent_messages=["Starting LangChain agent..."]
)

# Run agent with context
agent.run(f"""
{brief.operating_rules}

Task: Research Dr. Jane Smith and store her affiliation.
""")
```

---

## Using with AutoGen

Integrate Iranti with AutoGen agents:

```python
import autogen
from iranti import IrantiClient

iranti = IrantiClient()

# Register agent
iranti.register_agent(
    agent_id="autogen_assistant",
    name="AutoGen Assistant",
    description="AutoGen conversable agent with Iranti memory",
    capabilities=["conversation", "code_execution"],
    model="gpt-4"
)

# Create AutoGen agent
assistant = autogen.AssistantAgent(
    name="assistant",
    llm_config={"model": "gpt-4"},
)

# Get working memory
brief = iranti.handshake(
    agent="autogen_assistant",
    task="Research academic profiles",
    recent_messages=["Starting AutoGen conversation..."]
)

# Add memory to system message
assistant.system_message = f"""
{assistant.system_message}

Working Memory:
{chr(10).join(f"- {e.entity_key}: {e.summary}" for e in brief.working_memory)}

Operating Rules:
{brief.operating_rules}
"""

# After conversation, store findings
iranti.write(
    entity="researcher/jane_smith",
    key="research_focus",
    value={"primary": "machine learning", "secondary": "robotics"},
    summary="Primary focus: ML, secondary: robotics",
    confidence=85,
    source="Conversation",
    agent="autogen_assistant"
)
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `IRANTI_URL` | API server URL | `http://localhost:3001` |
| `IRANTI_API_KEY` | API key token (`keyId.secret`) or legacy shared key | Required |

Set in your environment:

```bash
export IRANTI_URL=http://localhost:3001
export IRANTI_API_KEY=your_key_here
```

Or in a `.env` file:

```env
IRANTI_URL=http://localhost:3001
IRANTI_API_KEY=your_key_here
```

Load with `python-dotenv`:

```python
from dotenv import load_dotenv
load_dotenv()

from iranti import IrantiClient
client = IrantiClient()  # Reads from environment
```

---

## Complete Example

```python
from iranti import IrantiClient, IrantiError

def main():
    # Initialize
    client = IrantiClient(
        base_url="http://localhost:3001",
        api_key="your_key_here"
    )

    # Check health
    print("Server status:", client.health()['status'])

    # Register agent
    client.register_agent(
        agent_id="demo_agent",
        name="Demo Agent",
        description="Demonstration agent",
        capabilities=["demo"],
        model="mock"
    )

    # Get working memory
    brief = client.handshake(
        agent="demo_agent",
        task="Research academic profiles",
        recent_messages=["Starting demo..."]
    )
    print(f"Task inferred: {brief.inferred_task_type}")

    # Write a fact
    result = client.write(
        entity="researcher/jane_smith",
        key="affiliation",
        value={"institution": "MIT"},
        summary="Affiliated with MIT",
        confidence=85,
        source="OpenAlex",
        agent="demo_agent"
    )
    print(f"Write: {result.action}")

    # Query it back
    query = client.query("researcher/jane_smith", "affiliation")
    if query.found:
        print(f"Found: {query.value}")

    # Create relationship
    client.relate(
        from_entity="researcher/jane_smith",
        relationship_type="MEMBER_OF",
        to_entity="lab/mit_csail",
        created_by="demo_agent"
    )

    # Get related entities
    related = client.get_related("researcher/jane_smith")
    print(f"Related entities: {len(related)}")

    # Run maintenance
    report = client.run_maintenance()
    print(f"Maintenance: {report.expired_archived} expired")

if __name__ == "__main__":
    try:
        main()
    except IrantiError as e:
        print(f"Error: {e}")
```

---

## Next Steps

- **[LLM Providers Guide](./providers.md)** — Configure real LLM providers
- **[Conflict Resolution Guide](./conflict-resolution.md)** — Understand how conflicts work
- **[Quickstart Guide](./quickstart.md)** — Set up the Iranti server

---

## Troubleshooting

### Connection refused

```
IrantiError: Could not connect to Iranti API at http://localhost:3001
```

**Solution**: Make sure the API server is running:

```bash
npm run api
```

### Invalid API key

```
IrantiAuthError: Invalid or missing API key
```

**Solution**: Check that `IRANTI_API_KEY` is a valid active token (`keyId.secret`) or matches the legacy server key.

### Timeout errors

```
IrantiError: Request timed out after 30s
```

**Solution**: Increase timeout when initializing:

```python
client = IrantiClient(timeout=60)  # 60 seconds
```

