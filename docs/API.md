# API Reference

Complete REST API documentation for Iranti.

---

## Base URL

```
http://localhost:3001  # Development
https://your-domain.com  # Production
```

## Authentication

All endpoints require API key in header:
```
X-Iranti-Key: your_api_key_here
```

**Example:**
```bash
curl -H "X-Iranti-Key: dev_test_key_12345" \
     http://localhost:3001/health
```

---

## Endpoints

### Health Check

**GET** `/health`

Check if API server is running.

**Response:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "provider": "openai"
}
```

---

### Write Fact

**POST** `/write`

Write or update a fact in the knowledge base.

**Request Body:**
```json
{
  "entity": "project/nexus_prime",
  "key": "deadline",
  "value": {"date": "June 18, 2028"},
  "summary": "Deadline: June 18, 2028",
  "confidence": 95,
  "source": "project_manager",
  "agent": "planning_agent_001"
}
```

**Parameters:**
- `entity` (string, required): Entity identifier in format `entityType/entityId`
- `key` (string, required): Fact key (e.g., "deadline", "budget", "status")
- `value` (object, required): Fact value as JSON object
- `summary` (string, required): Human-readable summary for working memory
- `confidence` (number, required): Confidence score 0-100
- `source` (string, required): Source of information
- `agent` (string, required): Agent ID that wrote the fact

**Response:**
```json
{
  "success": true,
  "action": "created",
  "fact": {
    "id": "uuid-here",
    "entity_type": "project",
    "entity_id": "nexus_prime",
    "key": "deadline",
    "value": {"date": "June 18, 2028"},
    "summary": "Deadline: June 18, 2028",
    "confidence": 95,
    "source": "project_manager",
    "agent": "planning_agent_001",
    "created_at": "2024-03-01T10:30:00Z",
    "updated_at": "2024-03-01T10:30:00Z"
  }
}
```

**Actions:**
- `created`: New fact created
- `updated`: Existing fact updated (higher confidence)
- `escalated`: Conflict detected, requires human review
- `rejected`: Lower confidence than existing fact

---

### Query Specific Fact

**GET** `/query/:entityType/:entityId/:key`

Retrieve a specific fact.

**Example:**
```bash
GET /query/project/nexus_prime/deadline
```

**Response (found):**
```json
{
  "found": true,
  "fact": {
    "id": "uuid-here",
    "entity_type": "project",
    "entity_id": "nexus_prime",
    "key": "deadline",
    "value": {"date": "June 18, 2028"},
    "summary": "Deadline: June 18, 2028",
    "confidence": 95,
    "source": "project_manager",
    "agent": "planning_agent_001",
    "created_at": "2024-03-01T10:30:00Z",
    "updated_at": "2024-03-01T10:30:00Z"
  }
}
```

**Response (not found):**
```json
{
  "found": false,
  "entity": "project/nexus_prime",
  "key": "deadline"
}
```

---

### Query All Facts for Entity

**GET** `/query/:entityType/:entityId`

Retrieve all facts for an entity.

**Example:**
```bash
GET /query/project/nexus_prime
```

**Response:**
```json
{
  "entity": "project/nexus_prime",
  "facts": [
    {
      "key": "deadline",
      "value": {"date": "June 18, 2028"},
      "summary": "Deadline: June 18, 2028",
      "confidence": 95,
      "source": "project_manager",
      "agent": "planning_agent_001"
    },
    {
      "key": "budget",
      "value": {"amount": "$12.4 million"},
      "summary": "Budget: $12.4 million",
      "confidence": 90,
      "source": "finance_system",
      "agent": "budget_agent_002"
    }
  ],
  "count": 2
}
```

---

### Context Persistence (observe)

**POST** `/observe`

Get facts that have fallen out of context window.

**Request Body:**
```json
{
  "agentId": "research_agent_001",
  "currentContext": "User: What's the deadline?\nAssistant: Let me check...",
  "maxFacts": 5
}
```

**Parameters:**
- `agentId` (string, required): Agent requesting facts
- `currentContext` (string, required): Current conversation context
- `maxFacts` (number, optional): Maximum facts to return (default: 10)

**Response:**
```json
{
  "facts": [
    {
      "entityKey": "project/nexus_prime:deadline",
      "summary": "Deadline: June 18, 2028",
      "confidence": 95,
      "relevance": 0.92
    },
    {
      "entityKey": "project/nexus_prime:budget",
      "summary": "Budget: $12.4 million",
      "confidence": 90,
      "relevance": 0.85
    }
  ],
  "count": 2,
  "entitiesDetected": ["project/nexus_prime"],
  "alreadyPresent": 0
}
```

---

### Working Memory (handshake)

**POST** `/handshake`

Get personalized brief for agent session start.

**Request Body:**
```json
{
  "agent": "research_agent_001",
  "task": "Research publication history for Dr. Jane Smith",
  "recentMessages": ["Starting literature review..."]
}
```

**Parameters:**
- `agent` (string, required): Agent ID
- `task` (string, required): Current task description
- `recentMessages` (array, optional): Recent conversation messages

**Response:**
```json
{
  "operatingRules": "You are research_agent_001. Focus on academic publications.",
  "inferredTaskType": "research",
  "workingMemory": [
    {
      "entityKey": "researcher/jane_smith:affiliation",
      "summary": "Affiliated with MIT CSAIL",
      "confidence": 85
    }
  ],
  "relevantEntities": ["researcher/jane_smith"]
}
```

---

### Create Relationship

**POST** `/relate`

Create relationship between entities.

**Request Body:**
```json
{
  "fromEntity": "researcher/jane_smith",
  "toEntity": "project/nexus_prime",
  "relationshipType": "MEMBER_OF",
  "properties": {"role": "Lead Researcher", "since": "2023-01-01"}
}
```

**Parameters:**
- `fromEntity` (string, required): Source entity
- `toEntity` (string, required): Target entity
- `relationshipType` (string, required): Relationship type (MEMBER_OF, PART_OF, AUTHORED, etc.)
- `properties` (object, optional): Additional metadata

**Response:**
```json
{
  "success": true,
  "relationship": {
    "id": "uuid-here",
    "from_entity_type": "researcher",
    "from_entity_id": "jane_smith",
    "to_entity_type": "project",
    "to_entity_id": "nexus_prime",
    "relationship_type": "MEMBER_OF",
    "properties": {"role": "Lead Researcher", "since": "2023-01-01"},
    "created_at": "2024-03-01T10:30:00Z"
  }
}
```

---

### Query Relationships

**GET** `/related/:entityType/:entityId`

Get all relationships for an entity.

**Query Parameters:**
- `direction` (string, optional): "outgoing", "incoming", or "both" (default: "both")
- `type` (string, optional): Filter by relationship type

**Example:**
```bash
GET /related/researcher/jane_smith?direction=outgoing&type=MEMBER_OF
```

**Response:**
```json
{
  "entity": "researcher/jane_smith",
  "relationships": [
    {
      "type": "MEMBER_OF",
      "target": "project/nexus_prime",
      "properties": {"role": "Lead Researcher"},
      "created_at": "2024-03-01T10:30:00Z"
    }
  ],
  "count": 1
}
```

---

### Register Agent

**POST** `/agents/register`

Register agent in registry.

**Request Body:**
```json
{
  "agentId": "research_agent_001",
  "name": "Research Agent",
  "type": "research",
  "capabilities": ["literature_review", "fact_extraction"],
  "metadata": {"version": "1.0.0"}
}
```

**Response:**
```json
{
  "success": true,
  "agent": {
    "id": "research_agent_001",
    "name": "Research Agent",
    "type": "research",
    "capabilities": ["literature_review", "fact_extraction"],
    "metadata": {"version": "1.0.0"},
    "registered_at": "2024-03-01T10:30:00Z"
  }
}
```

---

### Ingest Text (Future)

**POST** `/ingest`

Ingest raw text and auto-extract facts.

**Request Body:**
```json
{
  "text": "Project Nexus Prime has a deadline of June 18, 2028. The budget is $12.4 million.",
  "entity": "project/nexus_prime",
  "source": "project_document",
  "agent": "ingest_agent_001"
}
```

**Response:**
```json
{
  "success": true,
  "factsExtracted": 2,
  "facts": [
    {"key": "deadline", "summary": "Deadline: June 18, 2028", "confidence": 85},
    {"key": "budget", "summary": "Budget: $12.4 million", "confidence": 80}
  ]
}
```

---

## Error Responses

### 400 Bad Request

```json
{
  "error": "Missing required field: entity",
  "code": "VALIDATION_ERROR"
}
```

### 401 Unauthorized

```json
{
  "error": "Invalid API key",
  "code": "UNAUTHORIZED"
}
```

### 404 Not Found

```json
{
  "error": "Entity not found",
  "code": "NOT_FOUND"
}
```

### 500 Internal Server Error

```json
{
  "error": "Database connection failed",
  "code": "INTERNAL_ERROR"
}
```

---

## Rate Limiting

Default limits (configurable):
- 100 requests/minute per API key
- 1000 requests/hour per API key

**Response when rate limited:**
```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "retryAfter": 60
}
```

---

## Python Client

Wrapper for REST API:

```python
from clients.python.iranti import IrantiClient

client = IrantiClient(
    base_url="http://localhost:3001",
    api_key="your_key_here"
)

# Write
result = client.write(
    entity="project/test",
    key="status",
    value={"data": "active"},
    summary="Status: active",
    confidence=90,
    source="test",
    agent="test_agent"
)

# Query
fact = client.query("project/test", "status")
if fact.found:
    print(fact.value)

# Query all
facts = client.query_all("project/test")

# Observe
result = client.observe(
    agent_id="test_agent",
    current_context="test context",
    max_facts=5
)

# Handshake
brief = client.handshake(
    agent="test_agent",
    task="test task",
    recent_messages=[]
)
```

---

## TypeScript SDK

```typescript
import { IrantiClient } from './src/sdk';

const client = new IrantiClient({
  baseUrl: 'http://localhost:3001',
  apiKey: 'your_key_here'
});

// Write
const result = await client.write({
  entity: 'project/test',
  key: 'status',
  value: { data: 'active' },
  summary: 'Status: active',
  confidence: 90,
  source: 'test',
  agent: 'test_agent'
});

// Query
const fact = await client.query('project/test', 'status');

// Query all
const facts = await client.queryAll('project/test');
```

---

## Webhooks (Future)

Subscribe to events:

```json
POST /webhooks/subscribe
{
  "url": "https://your-app.com/webhook",
  "events": ["fact.created", "fact.updated", "conflict.escalated"]
}
```

**Webhook payload:**
```json
{
  "event": "fact.created",
  "timestamp": "2024-03-01T10:30:00Z",
  "data": {
    "entity": "project/nexus_prime",
    "key": "deadline",
    "value": {"date": "June 18, 2028"}
  }
}
```

---

## Versioning

API version in URL (future):
```
/v1/write
/v1/query/...
```

Current version: v0 (no version prefix)

---

## Support

- **Documentation**: https://github.com/nfemmanuel/iranti/tree/main/docs
- **Issues**: https://github.com/nfemmanuel/iranti/issues
- **Email**: oluwaniifemi.emmanuel@uni.minerva.edu
