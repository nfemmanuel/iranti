# Conflict Resolution Feature Specification

Complete technical specification for Iranti's conflict resolution system.

---

## Overview

When two agents write conflicting facts about the same entity, the Librarian detects the conflict and resolves it automatically using a combination of deterministic rules, source reliability weighting, and LLM reasoning.

---

## Inputs

### Entry Input

```typescript
interface EntryInput {
    entityType: string;
    entityId: string;
    key: string;
    valueRaw: unknown;
    valueSummary: string;
    confidence: number;        // 0-100
    source: string;
    validUntil?: Date;
    createdBy: string;
}
```

### Existing Entry (from KB)

```typescript
interface ExistingEntry {
    id: number;
    entityType: string;
    entityId: string;
    key: string;
    valueRaw: unknown;
    valueSummary: string;
    confidence: number;
    source: string;
    createdBy: string;
    createdAt: Date;
    conflictLog: ConflictLogEntry[];
}
```

### Source Reliability Scores

```typescript
interface ReliabilityScores {
    [source: string]: number;  // 0.1 - 1.0, default 0.5
}
```

---

## Outputs

### Write Result

```typescript
interface WriteResult {
    action: 'created' | 'updated' | 'rejected' | 'escalated';
    key: string;
    reason: string;
}
```

### Side Effects

1. **If KEEP_INCOMING:**
   - Existing entry moved to `archive` table
   - New entry written to `knowledge_base`
   - Conflict logged in new entry's `conflictLog`
   - Source reliability: incoming +0.03, existing -0.02

2. **If KEEP_EXISTING:**
   - Incoming entry rejected (not written)
   - Conflict logged in existing entry's `conflictLog`
   - Source reliability: existing +0.03, incoming -0.02

3. **If ESCALATE:**
   - Escalation file written to `escalation/active/`
   - Existing entry unchanged
   - Incoming entry not written
   - No reliability changes (yet)

---

## Decision Tree

```
START
  ↓
Load source reliability scores
  ↓
Calculate weighted confidence:
  weighted = raw × 0.7 + raw × reliability × 0.3
  ↓
Calculate confidence gap:
  gap = |weighted_incoming - weighted_existing|
  ↓
IF gap >= 10:
  ├─ Higher confidence wins (deterministic)
  └─ RETURN result
ELSE:
  ├─ Call LLM for reasoning
  ├─ Parse LLM response
  ├─ IF response is KEEP_EXISTING or KEEP_INCOMING:
  │    └─ Apply decision
  └─ ELSE (ESCALATE or unparseable):
       └─ Write escalation file
```

---

## Weighted Confidence Formula

```
weighted_confidence = raw_confidence × 0.7 + raw_confidence × reliability_score × 0.3
```

**Rationale:**
- 70% weight on raw confidence (agent's assessment)
- 30% weight on source reliability (historical accuracy)
- Balances immediate confidence with long-term trust

**Examples:**

```
Raw: 80, Reliability: 0.5 (neutral)
Weighted = 80 × 0.7 + 80 × 0.5 × 0.3 = 56 + 12 = 68

Raw: 80, Reliability: 0.8 (trusted)
Weighted = 80 × 0.7 + 80 × 0.8 × 0.3 = 56 + 19.2 = 75.2

Raw: 80, Reliability: 0.2 (untrusted)
Weighted = 80 × 0.7 + 80 × 0.2 × 0.3 = 56 + 4.8 = 60.8
```

---

## Confidence Gap Threshold

**Threshold:** 10 points

**Rationale:**
- Large enough to avoid false positives
- Small enough to catch meaningful differences
- Tested empirically with sample data

**Examples:**

```
Gap = 12 → Deterministic (clear winner)
Gap = 8  → LLM reasoning (ambiguous)
Gap = 2  → LLM reasoning (very ambiguous)
```

---

## LLM Reasoning Prompt

**Task Type:** `conflict_resolution`

**Model:** Configured via `CONFLICT_MODEL` env var (default: `gemini-2.5-pro`)

**Prompt Template:**

```
You are the Librarian in a multi-agent knowledge base system. Two agents have written conflicting facts about the same entity.

Entity: {entityType} / {entityId} / {key}

Existing Entry:
- Value: {existingValue}
- Confidence: {existingConfidence} (raw)
- Weighted Confidence: {existingWeighted}
- Source: {existingSource}
- Created By: {existingCreatedBy}
- Created At: {existingCreatedAt}

Incoming Entry:
- Value: {incomingValue}
- Confidence: {incomingConfidence} (raw)
- Weighted Confidence: {incomingWeighted}
- Source: {incomingSource}
- Created By: {incomingCreatedBy}

Confidence Gap: {gap} (too small for deterministic resolution)

Source Reliability History:
- {existingSource}: {existingReliability}
- {incomingSource}: {incomingReliability}

Your task: Decide which entry to keep.

Consider:
1. Source authority for this fact type
2. Recency of the data
3. Source reliability history
4. Whether the values are genuinely contradictory or complementary

Respond with ONE of:
- KEEP_EXISTING: [reason]
- KEEP_INCOMING: [reason]
- ESCALATE: [reason]

If genuinely ambiguous, choose ESCALATE.
```

**Response Parsing:**

```typescript
function parseConflictResolution(response: string): {
    decision: 'KEEP_EXISTING' | 'KEEP_INCOMING' | 'ESCALATE';
    reason: string;
} {
    const lines = response.trim().split('\n');
    const firstLine = lines[0].trim();

    if (firstLine.startsWith('KEEP_EXISTING:')) {
        return {
            decision: 'KEEP_EXISTING',
            reason: firstLine.substring('KEEP_EXISTING:'.length).trim(),
        };
    }

    if (firstLine.startsWith('KEEP_INCOMING:')) {
        return {
            decision: 'KEEP_INCOMING',
            reason: firstLine.substring('KEEP_INCOMING:'.length).trim(),
        };
    }

    if (firstLine.startsWith('ESCALATE:')) {
        return {
            decision: 'ESCALATE',
            reason: firstLine.substring('ESCALATE:'.length).trim(),
        };
    }

    // Unparseable → escalate
    return {
        decision: 'ESCALATE',
        reason: 'LLM response could not be parsed',
    };
}
```

---

## Escalation File Format

**Filename:** `{timestamp}_{entityType}_{entityId}_{key}.md`

**Example:** `2024-01-15T10-30-45_researcher_jane_smith_affiliation.md`

**Template:**

```markdown
**Status:** PENDING

## LIBRARIAN ASSESSMENT

**Entity:** {entityType} / {entityId} / {key}

**Conflict Detected:** {timestamp}

### Existing Entry
- **Value:** {existingValue}
- **Summary:** {existingSummary}
- **Confidence:** {existingConfidence} (weighted: {existingWeighted})
- **Source:** {existingSource}
- **Created By:** {existingCreatedBy}
- **Created At:** {existingCreatedAt}

### Incoming Entry
- **Value:** {incomingValue}
- **Summary:** {incomingSummary}
- **Confidence:** {incomingConfidence} (weighted: {incomingWeighted})
- **Source:** {incomingSource}
- **Created By:** {incomingCreatedBy}
- **Attempted At:** {timestamp}

### Librarian Reasoning
{llmReasoning}

**Recommendation:** {recommendation}

---

## HUMAN RESOLUTION

<!-- Write your resolution here in plain language, then change Status to RESOLVED -->
```

---

## Archivist Processing

When the Archivist finds a RESOLVED escalation file:

### Step 1: Extract Resolution

**LLM Prompt:**

```
Extract the resolution from this human-written escalation file.

File contents:
{fileContents}

Extract:
1. Which entry to keep (existing or incoming)
2. The final value to write (if specified)
3. Confidence score (default 100 if not specified)
4. Source (default HumanReview if not specified)
5. Any source reliability adjustments

Return as JSON:
{
    "decision": "keep_existing" | "keep_incoming",
    "value": {...},
    "confidence": 100,
    "source": "HumanReview",
    "reliabilityAdjustments": {
        "OpenAlex": -0.08,
        "ORCID": +0.08
    }
}
```

### Step 2: Apply Resolution

```typescript
if (resolution.decision === 'keep_incoming') {
    // Archive existing entry
    await archiveEntry(existingEntry, 'human_resolved');

    // Write new entry
    await createEntry({
        ...incomingEntry,
        confidence: resolution.confidence,
        source: resolution.source,
        createdBy: 'system',
    });
}

// Apply reliability adjustments
for (const [source, delta] of Object.entries(resolution.reliabilityAdjustments)) {
    await adjustReliability(source, delta);
}
```

### Step 3: Move Files

```typescript
// Move to resolved/
await fs.rename(
    `escalation/active/${filename}`,
    `escalation/resolved/${filename}`
);

// Copy to archived/
await fs.copyFile(
    `escalation/resolved/${filename}`,
    `escalation/archived/${timestamp}_${filename}`
);
```

---

## Conflict Log Format

```typescript
interface ConflictLogEntry {
    detectedAt: string;           // ISO datetime
    incomingSource: string;
    incomingConfidence: number;
    existingConfidence: number;
    resolution: 'overwritten' | 'kept' | 'escalated' | 'human_resolved';
    resolvedBy?: string;          // 'deterministic', 'librarian_llm', 'human'
    notes?: string;
}
```

**Example:**

```json
{
  "conflictLog": [
    {
      "detectedAt": "2024-01-15T10:30:45Z",
      "incomingSource": "ORCID",
      "incomingConfidence": 73,
      "existingConfidence": 75,
      "resolution": "kept",
      "resolvedBy": "librarian_llm",
      "notes": "OpenAlex more authoritative for academic affiliations"
    }
  ]
}
```

---

## Error Handling

### LLM Call Fails

```typescript
try {
    const response = await route('conflict_resolution', prompt);
    const decision = parseConflictResolution(response.text);
} catch (error) {
    // LLM failed → escalate
    return {
        decision: 'ESCALATE',
        reason: `LLM call failed: ${error.message}`,
    };
}
```

### Unparseable LLM Response

```typescript
if (!decision || !['KEEP_EXISTING', 'KEEP_INCOMING', 'ESCALATE'].includes(decision)) {
    return {
        decision: 'ESCALATE',
        reason: 'LLM response could not be parsed',
    };
}
```

### Escalation File Write Fails

```typescript
try {
    await writeEscalationFile(filename, content);
} catch (error) {
    // Log error but don't fail the write
    console.error('Failed to write escalation file:', error);
    // Keep existing entry (safe default)
    return {
        action: 'rejected',
        reason: `Escalation failed: ${error.message}`,
    };
}
```

---

## Performance Considerations

### Caching Reliability Scores

Load reliability scores once per write batch:

```typescript
const scores = await getReliabilityScores();  // Cache this

for (const entry of entries) {
    const weighted = calculateWeighted(entry, scores);
    // ...
}
```

### Async Escalation File Writes

Don't block the write on file I/O:

```typescript
// Write escalation file asynchronously
writeEscalationFile(filename, content).catch(console.error);

// Return immediately
return {
    action: 'escalated',
    reason: 'Conflict escalated to human review',
};
```

### LLM Call Timeout

Set a timeout for LLM calls:

```typescript
const response = await Promise.race([
    route('conflict_resolution', prompt),
    timeout(30000),  // 30 second timeout
]);
```

---

## Testing

### Unit Tests

```typescript
test('deterministic resolution: higher confidence wins', async () => {
    const result = await resolveConflict(
        { confidence: 90, source: 'A' },
        { confidence: 70, source: 'B' },
        { A: 0.5, B: 0.5 }
    );
    expect(result.decision).toBe('KEEP_INCOMING');
});

test('LLM resolution: close confidence', async () => {
    const result = await resolveConflict(
        { confidence: 75, source: 'A' },
        { confidence: 73, source: 'B' },
        { A: 0.5, B: 0.5 }
    );
    // Should call LLM
    expect(result.resolvedBy).toBe('librarian_llm');
});

test('escalation: genuinely ambiguous', async () => {
    // Mock LLM to return ESCALATE
    const result = await resolveConflict(
        { confidence: 75, source: 'A' },
        { confidence: 74, source: 'B' },
        { A: 0.5, B: 0.5 }
    );
    expect(result.action).toBe('escalated');
});
```

### Integration Tests

```typescript
test('full conflict resolution flow', async () => {
    // Write first entry
    await iranti.write({
        entity: 'test/entity',
        key: 'fact',
        value: { v: 1 },
        confidence: 80,
        source: 'A',
        agent: 'agent1',
    });

    // Write conflicting entry
    const result = await iranti.write({
        entity: 'test/entity',
        key: 'fact',
        value: { v: 2 },
        confidence: 85,
        source: 'B',
        agent: 'agent2',
    });

    expect(result.action).toBe('updated');

    // Check archive
    const archived = await prisma.archive.findFirst({
        where: { entityType: 'test', entityId: 'entity', key: 'fact' },
    });
    expect(archived).toBeTruthy();
});
```

---

## Monitoring

### Metrics to Track

1. **Conflict rate** — Conflicts per 1000 writes
2. **Resolution method** — Deterministic vs LLM vs escalated
3. **Escalation rate** — Escalations per 1000 conflicts
4. **LLM accuracy** — Human overrides per 100 LLM resolutions
5. **Resolution time** — P50, P95, P99 latency

### Logging

```typescript
console.log('[conflict]', {
    entity: `${entityType}/${entityId}`,
    key,
    decision: result.decision,
    resolvedBy: result.resolvedBy,
    gap: confidenceGap,
    latency: Date.now() - startTime,
});
```

---

## Future Enhancements

1. **Configurable threshold** — Allow per-deployment confidence gap threshold
2. **Multi-value resolution** — Handle cases where both values are correct
3. **Temporal resolution** — Prefer more recent data automatically
4. **Batch resolution** — Resolve multiple conflicts in one LLM call
5. **Human feedback loop** — Learn from human resolutions to improve LLM prompts

---

## References

- [Conflict Resolution Guide](../../guides/conflict-resolution.md)
- [Source Reliability Spec](../source-reliability/spec.md)
- [ADR 003: Flat KB](../../decisions/003-flat-kb-with-relationships.md)
