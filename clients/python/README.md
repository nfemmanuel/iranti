# Iranti Python Client

Python client for the Iranti REST API.

## Installation

```bash
pip install requests
```

No package install needed — copy `iranti.py` into your project.

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
print(f"Written: {result.written}, Rejected: {result.rejected}")

# Get working memory before a task
brief = client.handshake(
    agent="my_agent",
    task="Research publication history",
    recent_messages=["Starting research..."]
)
print(brief.inferred_task_type)

# Query facts
result = client.query("researcher/jane_smith", "affiliation")
if result.found:
    print(result.value)

# Find who knows what
knowers = client.who_knows("researcher/jane_smith")
for k in knowers:
    print(f"{k['agentId']}: {k['keys']}")
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
| `IRANTI_API_KEY` | API key matching server's IRANTI_API_KEY |
