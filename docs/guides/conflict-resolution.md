# Conflict Resolution Guide — How Iranti handles contradicting facts

Complete guide to understanding and working with Iranti's conflict resolution system.

---

## Overview

When two agents write conflicting facts about the same entity, Iranti doesn't silently overwrite. Instead, the Librarian:

1. Detects the conflict
2. Applies source reliability weighting
3. Decides how to resolve it (deterministic, LLM reasoning, or human escalation)
4. Logs the full decision with reasoning
5. Archives the losing entry with complete provenance

Nothing is ever lost. Every decision is auditable.

---

## What Counts as a Conflict?

A conflict occurs when:
- Same `entityType` + `entityId` + `key`
- Different `valueRaw`
- Both entries are active (not archived)

**Example conflict:**

```typescript
// Agent Alpha writes
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'MIT' },
    summary: 'Affiliated with MIT',
    confidence: 82,
    source: 'OpenAlex',
    agent: 'agent_alpha',
});

// Agent Beta writes (conflict!)
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'Stanford' },
    summary: 'Affiliated with Stanford',
    confidence: 79,
    source: 'ORCID',
    agent: 'agent_beta',
});
```

---

## Resolution Decision Tree

The Librarian follows this decision tree:

```
1. Load source reliability scores
   ↓
2. Apply weighted confidence
   weighted = raw × 0.7 + raw × reliability × 0.3
   ↓
3. Calculate confidence gap
   gap = |weighted_incoming - weighted_existing|
   ↓
4. IF gap >= 10:
     → Deterministic resolution (higher confidence wins)
   ELSE:
     → LLM reasoning
     ↓
     5. IF LLM returns clear decision:
          → Apply LLM decision
        ELSE:
          → Escalate to human
```

---

## Confidence Gap Threshold

**Gap ≥ 10 points** → Deterministic resolution

The higher confidence entry wins automatically. No LLM call needed.

**Example:**

```
Existing: MIT (confidence 75, OpenAlex, reliability 0.5)
  weighted = 75 × 0.7 + 75 × 0.5 × 0.3 = 63.75

Incoming: Stanford (confidence 90, ORCID, reliability 0.5)
  weighted = 90 × 0.7 + 90 × 0.5 × 0.3 = 76.5

Gap = 76.5 - 63.75 = 12.75 ≥ 10

Decision: KEEP_INCOMING (Stanford wins)
Reason: "Deterministic resolution: incoming confidence significantly higher (gap: 12.75)"
```

**Gap < 10 points** → LLM reasoning

The gap is too small for automatic resolution. The Librarian asks an LLM to reason about which source to trust.

---

## LLM Reasoning Path

When the confidence gap is < 10, the Librarian sends this prompt to the LLM:

```
You are the Librarian in a multi-agent knowledge base system. Two agents have written conflicting facts about the same entity.

Entity: researcher / jane_smith / affiliation

Existing Entry:
- Value: {"institution": "MIT"}
- Confidence: 75
- Source: OpenAlex
- Weighted Confidence: 63.75

Incoming Entry:
- Value: {"institution": "Stanford"}
- Confidence: 73
- Source: ORCID
- Weighted Confidence: 62.55

Confidence Gap: 1.2 (too small for deterministic resolution)

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

**LLM response examples:**

```
KEEP_EXISTING: OpenAlex is more authoritative for academic affiliations than ORCID. The confidence difference is minimal.
```

```
KEEP_INCOMING: ORCID data is typically more up-to-date for current affiliations. The researcher may have recently moved.
```

```
ESCALATE: Both sources have comparable authority for this fact type. The values are genuinely contradictory and the confidence gap is too small to resolve automatically.
```

---

## Resolution Actions

### KEEP_EXISTING (Reject Incoming)

The existing entry stays. The incoming entry is rejected.

**What happens:**
1. Existing entry remains in `knowledge_base`
2. Incoming entry is NOT written
3. Conflict logged in existing entry's `conflictLog`
4. Agent stats updated: `totalRejections++`
5. Source reliability: existing source +0.03, incoming source -0.02

**Return value:**

```typescript
{
    action: 'rejected',
    key: 'affiliation',
    reason: 'Librarian reasoning: kept existing. OpenAlex is more authoritative for academic affiliations.'
}
```

### KEEP_INCOMING (Replace Existing)

The incoming entry wins. The existing entry is archived.

**What happens:**
1. Existing entry moved to `archive` table with `archivedReason: 'superseded'`
2. Incoming entry written to `knowledge_base`
3. Archive entry has `supersededBy` pointing to new entry's ID
4. Conflict logged in new entry's `conflictLog`
5. Agent stats updated: `totalWrites++` for incoming agent
6. Source reliability: incoming source +0.03, existing source -0.02

**Return value:**

```typescript
{
    action: 'updated',
    key: 'affiliation',
    reason: 'Librarian reasoning: replaced existing. ORCID data is more up-to-date for current affiliations.'
}
```

### ESCALATE (Human Review Required)

The conflict is genuinely ambiguous. A human must decide.

**What happens:**
1. Escalation file written to `escalation/active/`
2. Existing entry remains in `knowledge_base` (unchanged)
3. Incoming entry is NOT written
4. Agent stats updated: `totalEscalations++`
5. No source reliability changes (yet)

**Return value:**

```typescript
{
    action: 'escalated',
    key: 'affiliation',
    reason: 'Escalated to human review: both sources have comparable authority and values are genuinely contradictory.'
}
```

---

## Escalation Files

Escalation files are written to `escalation/active/` as markdown:

**Filename format:** `{timestamp}_{entityType}_{entityId}_{key}.md`

**Example:** `2024-01-15T10-30-45_researcher_jane_smith_affiliation.md`

**File contents:**

```markdown
**Status:** PENDING

## LIBRARIAN ASSESSMENT

**Entity:** researcher / jane_smith / affiliation

**Conflict Detected:** 2024-01-15T10:30:45Z

### Existing Entry
- **Value:** {"institution": "MIT", "department": "CSAIL"}
- **Summary:** Affiliated with MIT CSAIL
- **Confidence:** 75 (weighted: 63.75)
- **Source:** OpenAlex
- **Created By:** agent_alpha
- **Created At:** 2024-01-10T08:00:00Z

### Incoming Entry
- **Value:** {"institution": "Stanford", "department": "CS"}
- **Summary:** Affiliated with Stanford CS
- **Confidence:** 73 (weighted: 62.55)
- **Source:** ORCID
- **Created By:** agent_beta
- **Attempted At:** 2024-01-15T10:30:45Z

### Librarian Reasoning
Sources have comparable authority for this fact type. OpenAlex is generally reliable for academic affiliations, but ORCID data can be more current. The confidence gap (1.2 points) is too small for deterministic resolution. The values are genuinely contradictory (different institutions).

**Recommendation:** Verify which institution is current. Check the researcher's personal website or recent publications.

---

## HUMAN RESOLUTION

<!-- Optional plain-language notes -->

### AUTHORITATIVE_JSON
```json
{
  "entityType": "researcher",
  "entityId": "jane_smith",
  "key": "affiliation",
  "value": { "institution": "Stanford", "department": "CS" },
  "summary": "Affiliated with Stanford CS",
  "validUntil": null,
  "notes": "Verified on researcher website and latest publication."
}
```
```

---

## Resolving Escalations

### Step 1: Review the Assessment

Read the Librarian's assessment. It includes:
- Both conflicting values
- Confidence scores (raw and weighted)
- Sources
- Reasoning about why it was escalated

### Step 2: Investigate

Use external sources to determine the truth:
- Check the researcher's personal website
- Look at recent publications
- Verify with institutional directories
- Check LinkedIn or other professional profiles

### Step 3: Write Your Resolution

In the `HUMAN RESOLUTION` section, include optional notes and a required `AUTHORITATIVE_JSON` block:

```markdown
## HUMAN RESOLUTION

Checked janesmith.com and Jan 2024 publication metadata. Stanford is current.

### AUTHORITATIVE_JSON
```json
{
  "entityType": "researcher",
  "entityId": "jane_smith",
  "key": "affiliation",
  "value": { "institution": "Stanford", "department": "CS" },
  "summary": "Affiliated with Stanford CS",
  "validUntil": null,
  "notes": "OpenAlex appeared stale; ORCID matched current profile."
}
```
```

### Step 4: Mark as Resolved

Change the status line:

```markdown
**Status:** RESOLVED
```

### Step 5: Save and Wait

Save the file. The Archivist will process it on the next maintenance cycle (or when you call `runMaintenance()`).

---

## Archivist Processing

When the Archivist finds a RESOLVED escalation file:

1. **Extract resolution** — Deterministically parses `AUTHORITATIVE_JSON`
2. **Write to KB** — Writes the decision as authoritative truth:
   - Confidence: 100
   - Source: HumanReview
   - Created by: system
3. **Enrichment (optional)** — May append non-authoritative LLM notes for audit
4. **Archive old entry** — Moves losing entry to archive with `archivedReason: 'human_resolved'`
5. **Move file** — Moves escalation file to `escalation/resolved/`
6. **Archive copy** — Copies file to `escalation/archived/` with timestamp

---

## Source Reliability Learning

After every conflict resolution, source reliability scores are updated.

**Winning source:** +0.03
**Losing source:** -0.02
**Human override:** +/- 0.08

**Example:**

```
Before conflict:
  OpenAlex: 0.50
  ORCID: 0.50

After resolution (ORCID wins):
  OpenAlex: 0.48
  ORCID: 0.53

After 10 more wins for ORCID:
  OpenAlex: 0.30
  ORCID: 0.80
```

**Weighted confidence impact:**

```
Raw confidence: 75
Reliability: 0.80

Weighted = 75 × 0.7 + 75 × 0.80 × 0.3
         = 52.5 + 18
         = 70.5

vs. with reliability 0.30:

Weighted = 75 × 0.7 + 75 × 0.30 × 0.3
         = 52.5 + 6.75
         = 59.25
```

Over time, trusted sources get higher effective confidence, making them more likely to win future conflicts.

**Decay:**

Scores slowly decay toward neutral (0.5) at 0.005 per update cycle. This prevents old patterns from permanently dominating.

```
After 100 updates with no conflicts:
  Score 0.80 → 0.75
  Score 0.30 → 0.35
```

---

## Conflict Log

Every entry has a `conflictLog` field that records all conflicts:

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
    },
    {
      "detectedAt": "2024-01-20T14:15:00Z",
      "incomingSource": "Wikipedia",
      "incomingConfidence": 65,
      "existingConfidence": 75,
      "resolution": "kept",
      "resolvedBy": "deterministic",
      "notes": "Confidence gap: 10.5"
    }
  ]
}
```

This provides full audit trail of all challenges to a fact.

---

## Best Practices

### For Agent Developers

1. **Use appropriate confidence** — Don't inflate confidence to win conflicts. Use realistic scores based on source quality.

2. **Choose good sources** — Cite authoritative sources. Over time, Iranti learns which sources are reliable.

3. **Handle rejections gracefully** — If your write is rejected, don't retry immediately. The existing entry won for a reason.

4. **Check conflict logs** — Before writing, query the entity and check `conflictLog` to see if this fact has been challenged before.

### For System Operators

1. **Monitor escalations** — Check `escalation/active/` regularly. Resolve escalations promptly.

2. **Review reliability scores** — Periodically check source reliability scores. If a source is consistently losing, investigate why.

3. **Adjust threshold** — If you're getting too many escalations, increase the confidence gap threshold (requires code change).

4. **Tune models** — Use better models for conflict resolution if quality is poor. See [Providers Guide](./providers.md).

### For Humans Resolving Escalations

1. **Be thorough** — Don't guess. Investigate and verify the truth.

2. **Document reasoning** — Explain why you made your decision. Future humans will thank you.

3. **Update reliability** — If a source is consistently wrong, apply a larger reliability penalty.

4. **Add context** — If the conflict reveals a data quality issue, document it in the resolution.

---

## Examples

### Example 1: Deterministic Resolution

```typescript
// Existing entry
{
    entity: 'researcher/jane_smith',
    key: 'publication_count',
    value: { count: 24 },
    confidence: 70,
    source: 'OpenAlex',
    // weighted: 70 × 0.7 + 70 × 0.5 × 0.3 = 59.5
}

// Incoming entry
{
    entity: 'researcher/jane_smith',
    key: 'publication_count',
    value: { count: 31 },
    confidence: 90,
    source: 'ORCID',
    // weighted: 90 × 0.7 + 90 × 0.5 × 0.3 = 76.5
}

// Gap: 76.5 - 59.5 = 17 ≥ 10
// Decision: KEEP_INCOMING (deterministic)
// Result: ORCID value (31) wins, OpenAlex value archived
```

### Example 2: LLM Resolution (Keep Existing)

```typescript
// Existing entry
{
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'MIT' },
    confidence: 82,
    source: 'OpenAlex',
    // weighted: 82 × 0.7 + 82 × 0.5 × 0.3 = 69.7
}

// Incoming entry
{
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'Harvard' },
    confidence: 79,
    source: 'Wikipedia',
    // weighted: 79 × 0.7 + 79 × 0.5 × 0.3 = 67.15
}

// Gap: 69.7 - 67.15 = 2.55 < 10
// LLM reasoning: "OpenAlex is more authoritative than Wikipedia for academic affiliations"
// Decision: KEEP_EXISTING
// Result: MIT value kept, Harvard value rejected
```

### Example 3: Escalation

```typescript
// Existing entry
{
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'MIT' },
    confidence: 75,
    source: 'OpenAlex',
    // weighted: 63.75
}

// Incoming entry
{
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'Stanford' },
    confidence: 73,
    source: 'ORCID',
    // weighted: 62.55
}

// Gap: 1.2 < 10
// LLM reasoning: "Both sources have comparable authority. Values are genuinely contradictory."
// Decision: ESCALATE
// Result: Escalation file written, human review required
```

---

## Monitoring Conflicts

### Query Conflict Logs

```typescript
const result = await iranti.query('researcher/jane_smith', 'affiliation');

if (result.found) {
    const entry = await prisma.knowledgeEntry.findFirst({
        where: {
            entityType: 'researcher',
            entityId: 'jane_smith',
            key: 'affiliation',
        },
    });

    console.log('Conflict history:', entry.conflictLog);
}
```

### Check Escalations

```bash
ls escalation/active/
```

### View Source Reliability

```typescript
import { getReliabilityScores } from './src/librarian/source-reliability';

const scores = await getReliabilityScores();
console.log(scores);
// { OpenAlex: 0.53, ORCID: 0.48, Wikipedia: 0.42 }
```

---

## Troubleshooting

### Too many escalations

**Problem:** Every conflict is being escalated.

**Solution:** 
1. Check LLM provider is working (not using mock)
2. Increase confidence gap threshold (requires code change)
3. Improve source reliability by resolving escalations

### Wrong resolutions

**Problem:** LLM is making bad decisions.

**Solution:**
1. Use a better model for conflict resolution (see [Providers Guide](./providers.md))
2. Review and resolve escalations to train source reliability
3. Adjust confidence scores to be more realistic

### Escalations not processing

**Problem:** Resolved escalations stay in `active/` folder.

**Solution:**
1. Make sure status is exactly `**Status:** RESOLVED`
2. Run maintenance: `await iranti.runMaintenance()`
3. Check Archivist logs for errors

---

## Next Steps

- **[Source Reliability Spec](../features/source-reliability/spec.md)** — Deep dive into reliability learning
- **[Conflict Resolution Spec](../features/conflict-resolution/spec.md)** — Full technical specification
- **[Providers Guide](./providers.md)** — Configure better models for conflict resolution
