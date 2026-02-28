# Chunking Feature Specification

Complete technical specification for Iranti's content chunking system.

---

## Overview

The chunker extracts atomic facts from raw text content. Instead of agents writing facts manually, they can ingest raw content and let Iranti extract structured facts automatically.

---

## Input Format

```typescript
interface IngestInput {
    entityType: string;
    entityId: string;
    rawContent: string;
    source: string;
    confidence: number;
    createdBy: string;
}
```

**Example:**

```typescript
await librarianIngest({
    entityType: 'researcher',
    entityId: 'jane_smith',
    rawContent: 'Dr. Jane Smith has 24 publications and previously worked at Google DeepMind from 2019 to 2022. Her research focuses on reinforcement learning and robotics.',
    source: 'OpenAlex',
    confidence: 80,
    createdBy: 'agent_001',
});
```

---

## Output Format

```typescript
interface ChunkedFact {
    key: string;
    value: unknown;
    summary: string;
}

interface ChunkResult {
    facts: ChunkedFact[];
}
```

**Example output:**

```json
{
  "facts": [
    {
      "key": "publication_count",
      "value": {"count": 24},
      "summary": "Has published 24 papers"
    },
    {
      "key": "previous_employer",
      "value": {"institution": "Google DeepMind", "from": 2019, "to": 2022},
      "summary": "Previously worked at Google DeepMind from 2019 to 2022"
    },
    {
      "key": "research_focus",
      "value": {"primary": "reinforcement learning", "secondary": "robotics"},
      "summary": "Primary research focus is reinforcement learning with secondary interest in robotics"
    }
  ]
}
```

---

## LLM Extraction Prompt

**Task Type:** `extraction`

**Model:** Configured via `EXTRACTION_MODEL` env var (default: `gemini-2.0-flash-001`)

**Prompt Template:**

```
You are extracting atomic facts from raw text content about an entity.

Entity: {entityType} / {entityId}

Raw Content:
{rawContent}

Your task: Extract every distinct, atomic fact from this content.

Rules:
1. Each fact must be independent (can be understood without other facts)
2. Each fact must have a clear key (e.g., "affiliation", "publication_count")
3. Each fact must have a structured value (JSON object)
4. Each fact must have a one-sentence summary

Return a JSON array of facts:
[
  {
    "key": "fact_key",
    "value": {"structured": "data"},
    "summary": "One sentence summary"
  }
]

Examples:
- "Dr. Smith has 24 publications" → {"key": "publication_count", "value": {"count": 24}, "summary": "Has published 24 papers"}
- "She works at MIT" → {"key": "affiliation", "value": {"institution": "MIT"}, "summary": "Affiliated with MIT"}
- "Her research focuses on ML" → {"key": "research_focus", "value": {"primary": "machine learning"}, "summary": "Primary research focus is machine learning"}

Extract all facts from the content above.
```

---

## Response Parsing

```typescript
function parseChunkedFacts(response: string): ChunkedFact[] {
    try {
        // Try to parse as JSON array
        const facts = JSON.parse(response);

        if (!Array.isArray(facts)) {
            throw new Error('Response is not an array');
        }

        // Validate each fact
        return facts.filter((fact) => {
            return (
                typeof fact.key === 'string' &&
                fact.value !== undefined &&
                typeof fact.summary === 'string'
            );
        });
    } catch (error) {
        console.error('Failed to parse chunked facts:', error);
        return [];
    }
}
```

**Error handling:**
- If parsing fails, return empty array
- If individual facts are malformed, filter them out
- Log errors but don't fail the ingest

---

## Integration with Librarian Write Pipeline

After chunking, each fact is written through the normal Librarian pipeline:

```typescript
export async function librarianIngest(input: IngestInput): Promise<IngestResult> {
    // Step 1: Chunk content
    const chunkResult = await chunkContent(input.rawContent);

    // Step 2: Write each fact through Librarian
    const results: WriteResult[] = [];
    let written = 0;
    let rejected = 0;
    let escalated = 0;

    for (const fact of chunkResult.facts) {
        const result = await librarianWrite({
            entityType: input.entityType,
            entityId: input.entityId,
            key: fact.key,
            valueRaw: fact.value,
            valueSummary: fact.summary,
            confidence: input.confidence,
            source: input.source,
            createdBy: input.createdBy,
        });

        results.push(result);

        if (result.action === 'created' || result.action === 'updated') {
            written++;
        } else if (result.action === 'rejected') {
            rejected++;
        } else if (result.action === 'escalated') {
            escalated++;
        }
    }

    return {
        written,
        rejected,
        escalated,
        results,
    };
}
```

**Benefits:**
- Each fact goes through conflict resolution
- Each fact gets source reliability weighting
- Each fact can be rejected or escalated independently
- Full audit trail for each fact

---

## Example Flows

### Example 1: Simple Facts

**Input:**

```
Dr. Jane Smith has 24 publications and is affiliated with MIT.
```

**Extracted facts:**

```json
[
  {
    "key": "publication_count",
    "value": {"count": 24},
    "summary": "Has published 24 papers"
  },
  {
    "key": "affiliation",
    "value": {"institution": "MIT"},
    "summary": "Affiliated with MIT"
  }
]
```

**Write results:**

```
publication_count: created
affiliation: created
```

### Example 2: Conflicting Facts

**Input:**

```
Dr. Jane Smith has 31 publications according to ORCID.
```

**Extracted facts:**

```json
[
  {
    "key": "publication_count",
    "value": {"count": 31},
    "summary": "Has published 31 papers"
  }
]
```

**Write results:**

```
publication_count: updated (conflict resolved, ORCID wins)
```

### Example 3: Complex Facts

**Input:**

```
Dr. Jane Smith previously worked at Google DeepMind from 2019 to 2022, where she led the robotics team. Her research focuses on reinforcement learning with applications in autonomous systems. She has an h-index of 14 and has been cited over 450 times.
```

**Extracted facts:**

```json
[
  {
    "key": "previous_employer",
    "value": {
      "institution": "Google DeepMind",
      "from": 2019,
      "to": 2022,
      "role": "Robotics Team Lead"
    },
    "summary": "Previously worked at Google DeepMind from 2019 to 2022 as Robotics Team Lead"
  },
  {
    "key": "research_focus",
    "value": {
      "primary": "reinforcement learning",
      "applications": ["autonomous systems"]
    },
    "summary": "Primary research focus is reinforcement learning with applications in autonomous systems"
  },
  {
    "key": "h_index",
    "value": {"score": 14},
    "summary": "H-index of 14"
  },
  {
    "key": "citation_count",
    "value": {"count": 450},
    "summary": "Cited over 450 times"
  }
]
```

**Write results:**

```
previous_employer: created
research_focus: created
h_index: created
citation_count: created
```

---

## Error Handling

### LLM Call Fails

```typescript
try {
    const response = await route('extraction', prompt);
    const facts = parseChunkedFacts(response.text);
} catch (error) {
    console.error('Chunking failed:', error);
    return {
        written: 0,
        rejected: 0,
        escalated: 0,
        results: [],
    };
}
```

**Behavior:** Return empty result, log error, don't fail the ingest

### Malformed Response

```typescript
const facts = parseChunkedFacts(response.text);

if (facts.length === 0) {
    console.warn('No facts extracted from content');
}
```

**Behavior:** Continue with empty array, log warning

### Individual Fact Write Fails

```typescript
for (const fact of facts) {
    try {
        const result = await librarianWrite({...});
        results.push(result);
    } catch (error) {
        console.error(`Failed to write fact ${fact.key}:`, error);
        results.push({
            action: 'rejected',
            key: fact.key,
            reason: `Write failed: ${error.message}`,
        });
        rejected++;
    }
}
```

**Behavior:** Continue with remaining facts, log error, count as rejected

---

## Performance Considerations

### Batch Processing

For multiple ingests, batch LLM calls:

```typescript
const prompts = contents.map((content) => buildPrompt(content));
const responses = await Promise.all(
    prompts.map((prompt) => route('extraction', prompt))
);
```

### Caching

Cache extracted facts for identical content:

```typescript
const cacheKey = hash(rawContent);
const cached = cache.get(cacheKey);

if (cached) {
    return cached;
}

const facts = await chunkContent(rawContent);
cache.set(cacheKey, facts);
return facts;
```

### Timeout

Set timeout for LLM calls:

```typescript
const response = await Promise.race([
    route('extraction', prompt),
    timeout(30000),  // 30 seconds
]);
```

---

## Quality Considerations

### Fact Granularity

**Good (atomic):**

```json
{"key": "publication_count", "value": {"count": 24}}
{"key": "affiliation", "value": {"institution": "MIT"}}
```

**Bad (too coarse):**

```json
{"key": "profile", "value": {"publications": 24, "affiliation": "MIT"}}
```

**Why:** Coarse facts can't be updated independently

### Key Naming

**Good (descriptive):**

```json
{"key": "publication_count"}
{"key": "h_index"}
{"key": "research_focus"}
```

**Bad (generic):**

```json
{"key": "data1"}
{"key": "info"}
{"key": "value"}
```

**Why:** Generic keys make queries harder

### Value Structure

**Good (structured):**

```json
{"key": "affiliation", "value": {"institution": "MIT", "department": "CSAIL"}}
```

**Bad (unstructured):**

```json
{"key": "affiliation", "value": "MIT CSAIL"}
```

**Why:** Structured values are easier to query and compare

---

## Testing

### Unit Tests

```typescript
test('extracts facts from simple content', async () => {
    const result = await chunkContent(
        'Dr. Smith has 24 publications and works at MIT.'
    );

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].key).toBe('publication_count');
    expect(result.facts[1].key).toBe('affiliation');
});

test('handles empty content', async () => {
    const result = await chunkContent('');
    expect(result.facts).toHaveLength(0);
});

test('handles malformed LLM response', async () => {
    // Mock LLM to return invalid JSON
    const result = await chunkContent('test content');
    expect(result.facts).toHaveLength(0);
});
```

### Integration Tests

```typescript
test('ingest writes all extracted facts', async () => {
    const result = await iranti.ingest({
        entity: 'researcher/test',
        content: 'Dr. Test has 10 publications and works at Stanford.',
        source: 'Test',
        confidence: 80,
        agent: 'test_agent',
    });

    expect(result.written).toBe(2);
    expect(result.rejected).toBe(0);

    // Verify facts were written
    const pubCount = await iranti.query('researcher/test', 'publication_count');
    expect(pubCount.found).toBe(true);

    const affiliation = await iranti.query('researcher/test', 'affiliation');
    expect(affiliation.found).toBe(true);
});

test('ingest handles conflicts', async () => {
    // Write initial fact
    await iranti.write({
        entity: 'researcher/test',
        key: 'publication_count',
        value: {count: 20},
        summary: 'Has 20 publications',
        confidence: 90,
        source: 'A',
        agent: 'agent1',
    });

    // Ingest conflicting content
    const result = await iranti.ingest({
        entity: 'researcher/test',
        content: 'Dr. Test has 25 publications.',
        source: 'B',
        confidence: 85,
        agent: 'agent2',
    });

    // Should resolve conflict
    expect(result.written + result.rejected + result.escalated).toBe(1);
});
```

---

## Monitoring

### Metrics to Track

1. **Extraction rate** — Facts extracted per ingest
2. **Extraction quality** — Percentage of facts successfully written
3. **Extraction latency** — Time to extract facts
4. **Conflict rate** — Conflicts per extracted fact

### Logging

```typescript
console.log('[chunking]', {
    entityType,
    entityId,
    contentLength: rawContent.length,
    factsExtracted: facts.length,
    written,
    rejected,
    escalated,
    latency: Date.now() - startTime,
});
```

---

## Future Enhancements

1. **Confidence per fact** — LLM assigns confidence to each extracted fact
2. **Fact validation** — Validate extracted facts against schema
3. **Incremental extraction** — Extract only new facts from updated content
4. **Multi-entity extraction** — Extract facts about multiple entities from one text
5. **Relationship extraction** — Extract relationships between entities

---

## References

- [Conflict Resolution Spec](../conflict-resolution/spec.md)
- [Python Client Guide](../../guides/python-client.md)
- [Providers Guide](../../guides/providers.md)
