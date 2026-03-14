# Iranti Python Client

Python client for the Iranti REST API.

## Installation

```bash
pip install iranti
```

For local development from this repository:

```bash
cd clients/python
pip install -e .
```

## Setup

Start the Iranti API server first:

```bash
# In your Iranti directory
npm run api
```

## Usage

```python
from iranti import IrantiClient

client = IrantiClient(
    base_url="http://localhost:3001",
    api_key="your_key_here"
)

# Or use environment variables
# IRANTI_URL=http://localhost:3001
# IRANTI_API_KEY=your_key_here
client = IrantiClient()

# Check server is running
print(client.health())

# Write a fact
result = client.write(
    entity="researcher/jane_smith",
    key="affiliation",
    value={"institution": "MIT"},
    summary="Affiliated with MIT",
    confidence=85,
    source="OpenAlex",
    agent="my_agent"
)
print(result.action)  # created / updated / rejected / escalated

# Ingest raw text
result = client.ingest(
    entity="researcher/jane_smith",
    content="Dr. Jane Smith has 24 publications and is at MIT CSAIL.",
    source="OpenAlex",
    confidence=80,
    agent="my_agent"
)
print(
    f"Extracted: {result.extracted_candidates}, "
    f"Written: {result.written}, "
    f"Skipped malformed: {result.skipped_malformed}"
)

# Get working memory before a task
brief = client.handshake(
    agent="my_agent",
    task="Research publication history",
    recent_messages=["Starting research..."]
)
print(brief.inferred_task_type)

# Per-turn memory decision (inject only when needed)
turn = client.attend(
    agent_id="my_agent",
    latest_message="What is my favorite snack?",
    current_context="User: What is my favorite snack?\nAssistant:",
    entity_hints=["user/main"]
)
print(turn["shouldInject"], turn["reason"])

# Query facts
result = client.query("researcher/jane_smith", "affiliation")
if result.found:
    print(result.value)
```

## Error Handling

```python
from iranti import IrantiClient, IrantiAuthError, IrantiValidationError, IrantiError

try:
    result = client.write(...)
except IrantiAuthError:
    print("Invalid API key")
except IrantiValidationError as e:
    print(f"Bad input: {e}")
except IrantiError as e:
    print(f"API error: {e}")
```

## Environment Variables

| Variable | Description |
|---|---|
| `IRANTI_URL` | API server URL (default: http://localhost:3001) |
| `IRANTI_API_KEY` | API token (`keyId.secret`) or legacy shared server key |

## License

AGPL-3.0-or-later.
