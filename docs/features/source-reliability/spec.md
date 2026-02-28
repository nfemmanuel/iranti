# Source Reliability Feature Specification

Complete technical specification for Iranti's source reliability learning system.

---

## Overview

Iranti tracks which sources produce accurate findings over time. After every conflict resolution, reliability scores are updated. These scores are used to weight confidence in future writes, making trusted sources more likely to win conflicts.

---

## Score Initialization

**Default score:** 0.5 (neutral)

**Range:** 0.1 - 1.0

**Rationale:**
- 0.5 is neutral (no bias)
- 0.1 minimum prevents complete distrust
- 1.0 maximum prevents overconfidence

**First write from a source:**

```typescript
const reliability = scores[source] ?? 0.5;
```

Unknown sources start at neutral.

---

## Score Updates

### Win Delta

**Value:** +0.03

**Applied when:** Source wins a conflict resolution

**Example:**

```
Before: OpenAlex = 0.50
Conflict: OpenAlex wins vs Wikipedia
After: OpenAlex = 0.53
```

### Loss Delta

**Value:** -0.02

**Applied when:** Source loses a conflict resolution

**Example:**

```
Before: Wikipedia = 0.50
Conflict: Wikipedia loses vs OpenAlex
After: Wikipedia = 0.48
```

### Human Override Delta

**Value:** +/- 0.08

**Applied when:** Human resolves an escalation

**Rationale:** Human decisions are more significant than LLM decisions

**Example:**

```
Before: ORCID = 0.50, OpenAlex = 0.50
Human resolution: ORCID correct, OpenAlex wrong
After: ORCID = 0.58, OpenAlex = 0.42
```

---

## Decay

**Rate:** 0.005 per update cycle

**Direction:** Toward neutral (0.5)

**Applied:** On every score update (win, loss, or decay-only)

**Formula:**

```typescript
function applyDecay(score: number): number {
    if (score > 0.5) {
        return Math.max(0.5, score - 0.005);
    } else if (score < 0.5) {
        return Math.min(0.5, score + 0.005);
    }
    return score;
}
```

**Rationale:**
- Prevents old patterns from permanently dominating
- Allows sources to recover from past mistakes
- Keeps scores responsive to recent behavior

**Example:**

```
After 100 updates with no conflicts:
  Score 0.80 → 0.75 (decayed toward 0.5)
  Score 0.30 → 0.35 (decayed toward 0.5)
```

---

## Weighted Confidence Formula

```
weighted_confidence = raw_confidence × 0.7 + raw_confidence × reliability_score × 0.3
```

**Components:**
- 70% weight on raw confidence (agent's assessment)
- 30% weight on reliability-adjusted confidence

**Examples:**

```
Raw: 80, Reliability: 0.5 (neutral)
Weighted = 80 × 0.7 + 80 × 0.5 × 0.3
         = 56 + 12
         = 68

Raw: 80, Reliability: 0.8 (trusted)
Weighted = 80 × 0.7 + 80 × 0.8 × 0.3
         = 56 + 19.2
         = 75.2

Raw: 80, Reliability: 0.2 (untrusted)
Weighted = 80 × 0.7 + 80 × 0.2 × 0.3
         = 56 + 4.8
         = 60.8
```

**Impact on conflicts:**

```
Scenario 1: Both sources neutral
  A: raw 80, reliability 0.5 → weighted 68
  B: raw 75, reliability 0.5 → weighted 63.75
  Gap: 4.25 → LLM reasoning

Scenario 2: A is trusted, B is untrusted
  A: raw 80, reliability 0.8 → weighted 75.2
  B: raw 75, reliability 0.2 → weighted 60.8
  Gap: 14.4 → Deterministic (A wins)
```

Over time, trusted sources win more conflicts automatically.

---

## Persistence

Reliability scores are stored in the Staff Namespace:

```typescript
// Entity: system / librarian / source_reliability
{
    entityType: 'system',
    entityId: 'librarian',
    key: 'source_reliability',
    valueRaw: {
        OpenAlex: 0.53,
        ORCID: 0.58,
        Wikipedia: 0.42,
        GoogleScholar: 0.50,
    },
    valueSummary: 'Per-source reliability scores',
    confidence: 100,
    source: 'system',
    createdBy: 'system',
    isProtected: true,
}
```

**Protected:** Yes (Staff Namespace)

**Updated:** After every conflict resolution

---

## API

### Get Reliability Scores

```typescript
import { getReliabilityScores } from './src/librarian/source-reliability';

const scores = await getReliabilityScores();
// { OpenAlex: 0.53, ORCID: 0.58, Wikipedia: 0.42 }
```

### Record Resolution

```typescript
import { recordResolution } from './src/librarian/source-reliability';

await recordResolution({
    winningSource: 'ORCID',
    losingSource: 'OpenAlex',
    isHumanOverride: false,
});
```

**Side effects:**
- Winning source: +0.03 (or +0.08 if human)
- Losing source: -0.02 (or -0.08 if human)
- Both scores: decay applied
- Scores clamped to [0.1, 1.0]
- Updated scores written to KB

### Calculate Weighted Confidence

```typescript
import { weightedConfidence } from './src/librarian/source-reliability';

const weighted = await weightedConfidence(80, 'OpenAlex');
// Returns weighted confidence based on current reliability score
```

---

## Implementation

### Data Structure

```typescript
interface ReliabilityScores {
    [source: string]: number;  // 0.1 - 1.0
}
```

### Load Scores

```typescript
export async function getReliabilityScores(): Promise<ReliabilityScores> {
    const entry = await queryEntry({
        entityType: 'system',
        entityId: 'librarian',
        key: 'source_reliability',
    });

    if (!entry.found || !entry.entry) {
        return {};  // No scores yet
    }

    return entry.entry.valueRaw as ReliabilityScores;
}
```

### Update Scores

```typescript
export async function recordResolution(input: {
    winningSource: string;
    losingSource: string;
    isHumanOverride: boolean;
}): Promise<void> {
    const scores = await getReliabilityScores();

    const winDelta = input.isHumanOverride ? 0.08 : 0.03;
    const lossDelta = input.isHumanOverride ? 0.08 : 0.02;

    // Update winning source
    const winScore = scores[input.winningSource] ?? 0.5;
    scores[input.winningSource] = clamp(
        applyDecay(winScore + winDelta),
        0.1,
        1.0
    );

    // Update losing source
    const loseScore = scores[input.losingSource] ?? 0.5;
    scores[input.losingSource] = clamp(
        applyDecay(loseScore - lossDelta),
        0.1,
        1.0
    );

    // Write back to KB
    await updateEntry({
        entityType: 'system',
        entityId: 'librarian',
        key: 'source_reliability',
        valueRaw: scores,
        valueSummary: 'Per-source reliability scores',
        confidence: 100,
        source: 'system',
        createdBy: 'system',
    });
}
```

### Calculate Weighted Confidence

```typescript
export async function weightedConfidence(
    rawConfidence: number,
    source: string
): Promise<number> {
    const scores = await getReliabilityScores();
    const reliability = scores[source] ?? 0.5;

    return rawConfidence * 0.7 + rawConfidence * reliability * 0.3;
}
```

---

## Learning Curve

### Example: 10 Conflicts

```
Initial state:
  OpenAlex: 0.50
  ORCID: 0.50

Conflict 1: ORCID wins
  OpenAlex: 0.48
  ORCID: 0.53

Conflict 2: ORCID wins
  OpenAlex: 0.46
  ORCID: 0.56

Conflict 3: OpenAlex wins
  OpenAlex: 0.49
  ORCID: 0.54

Conflict 4-10: ORCID wins 6 times, OpenAlex wins 1 time
  OpenAlex: 0.42
  ORCID: 0.68
```

After 10 conflicts, ORCID has a clear reliability advantage.

### Impact on Future Conflicts

```
New conflict:
  OpenAlex: raw 80 → weighted 67.2
  ORCID: raw 75 → weighted 71.25

Gap: 4.05 → LLM reasoning (but ORCID has advantage)

vs. if both were neutral:
  OpenAlex: raw 80 → weighted 68
  ORCID: raw 75 → weighted 63.75

Gap: 4.25 → LLM reasoning (OpenAlex has advantage)
```

Reliability scores flip the advantage.

---

## Edge Cases

### New Source vs Established Source

```
New source (reliability 0.5):
  Raw 85 → Weighted 72.25

Established trusted source (reliability 0.8):
  Raw 80 → Weighted 75.2

Gap: 2.95 → LLM reasoning
```

New sources need higher raw confidence to compete with established sources.

### Untrusted Source

```
Untrusted source (reliability 0.2):
  Raw 90 → Weighted 68.4

Neutral source (reliability 0.5):
  Raw 75 → Weighted 63.75

Gap: 4.65 → LLM reasoning
```

Even with high raw confidence, untrusted sources struggle.

### Recovery from Low Score

```
Source with reliability 0.2 needs to win ~15 conflicts to reach 0.5:
  0.2 + (0.03 × 15) - (0.005 × 15) = 0.2 + 0.45 - 0.075 = 0.575
```

Recovery is possible but requires consistent wins.

---

## Monitoring

### Metrics to Track

1. **Score distribution** — Histogram of reliability scores
2. **Score changes** — Deltas per conflict
3. **Win rate by source** — Percentage of conflicts won
4. **Weighted confidence impact** — Average boost/penalty from reliability

### Logging

```typescript
console.log('[reliability]', {
    source: 'OpenAlex',
    oldScore: 0.50,
    newScore: 0.53,
    delta: +0.03,
    reason: 'won_conflict',
});
```

### Queries

```typescript
// Get all scores
const scores = await getReliabilityScores();

// Get score for specific source
const score = scores['OpenAlex'] ?? 0.5;

// Get top sources
const top = Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
```

---

## Testing

### Unit Tests

```typescript
test('win increases score', async () => {
    await recordResolution({
        winningSource: 'A',
        losingSource: 'B',
        isHumanOverride: false,
    });

    const scores = await getReliabilityScores();
    expect(scores.A).toBeGreaterThan(0.5);
    expect(scores.B).toBeLessThan(0.5);
});

test('human override has larger impact', async () => {
    await recordResolution({
        winningSource: 'A',
        losingSource: 'B',
        isHumanOverride: true,
    });

    const scores = await getReliabilityScores();
    expect(scores.A).toBe(0.58);  // 0.5 + 0.08
    expect(scores.B).toBe(0.42);  // 0.5 - 0.08
});

test('scores decay toward neutral', () => {
    expect(applyDecay(0.8)).toBe(0.795);
    expect(applyDecay(0.2)).toBe(0.205);
    expect(applyDecay(0.5)).toBe(0.5);
});

test('scores clamped to range', () => {
    expect(clamp(1.5, 0.1, 1.0)).toBe(1.0);
    expect(clamp(0.05, 0.1, 1.0)).toBe(0.1);
});
```

### Integration Tests

```typescript
test('reliability affects conflict resolution', async () => {
    // Set up: A is trusted, B is untrusted
    await recordResolution({
        winningSource: 'A',
        losingSource: 'B',
        isHumanOverride: true,
    });

    // Write from A
    await iranti.write({
        entity: 'test/entity',
        key: 'fact',
        value: { v: 1 },
        confidence: 75,
        source: 'A',
        agent: 'agent1',
    });

    // Write from B (higher raw confidence)
    const result = await iranti.write({
        entity: 'test/entity',
        key: 'fact',
        value: { v: 2 },
        confidence: 80,
        source: 'B',
        agent: 'agent2',
    });

    // A should win despite lower raw confidence
    expect(result.action).toBe('rejected');
});
```

---

## Future Enhancements

1. **Per-fact-type reliability** — Track reliability per (source, fact_type) pair
2. **Time-based decay** — Decay based on time, not just update count
3. **Confidence calibration** — Learn if a source over/under-estimates confidence
4. **Source clustering** — Group similar sources (e.g., all academic databases)
5. **Explainability** — Show reliability history in escalation files

---

## References

- [Conflict Resolution Spec](../conflict-resolution/spec.md)
- [Conflict Resolution Guide](../../guides/conflict-resolution.md)
- [ADR 002: Per-Agent Attendants](../../decisions/002-per-agent-attendants.md)
