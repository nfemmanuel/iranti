# Memory Decay

## Overview

Memory decay adds an opt-in Ebbinghaus-inspired forgetting pass to the Archivist. Facts track last access time and stability so frequently-used knowledge decays more slowly than stale unused facts.

## Inputs

| Input | Type | Description |
|---|---|---|
| `IRANTI_DECAY_ENABLED` | boolean env var | Enables the decay pass during Archivist maintenance |
| `IRANTI_DECAY_STABILITY_BASE` | number env var | Starting stability in days |
| `IRANTI_DECAY_STABILITY_INCREMENT` | number env var | Stability increase per access |
| `IRANTI_DECAY_STABILITY_MAX` | number env var | Maximum allowed stability |
| `IRANTI_DECAY_THRESHOLD` | number env var | Confidence threshold below which a fact is archived |
| `lastAccessedAt` | timestamp | Last agent-visible access time for a fact |
| `stability` | float | Current decay resistance for a fact |

## Outputs

| Output | Type | Description |
|---|---|---|
| Updated fact confidence | integer | Decayed confidence after maintenance |
| Archived expired fact | archive row | Fact moved to archive when decayed confidence drops below threshold |
| Access metadata update | timestamp + float | `lastAccessedAt` reset and `stability` incremented on agent-visible access |

## Decision Tree / Flow

1. On write, initialize `lastAccessedAt` and `stability` on the KB row.
2. On agent-visible read paths (`query`, `queryAll`, `handshake`, `observe`, `attend`), record access:
   - set `lastAccessedAt = now`
   - increment `stability`, capped by config.
3. During Archivist maintenance:
   - skip decay entirely unless `IRANTI_DECAY_ENABLED=true`
   - compute `new_confidence = original_confidence * e^(-days_since_access / stability)`
   - update confidence in place
   - archive the fact if the decayed confidence falls below `IRANTI_DECAY_THRESHOLD`

## Edge Cases

- Protected Staff entries do not decay.
- Search results do not count as access because they are not confirmed context injection.
- `originalConfidence` is preserved in `properties` to avoid compounding decay against already-decayed confidence.
- Facts already archived are not processed by the decay pass.
- Repeated accesses on the same fact saturate at `IRANTI_DECAY_STABILITY_MAX`.

## Test Results

- Formula test verifies exact decay output for a known input.
- Integration test verifies confidence decreases after simulated time passes.
- Integration test verifies repeated accesses increase stability and slow decay.
- Integration test verifies low-retention facts are archived through the existing Archivist path.

## Related

- [Decay internals](/C:/Users/NF/Documents/Projects/iranti/docs/internal/decay.md)
- [Archivist](/C:/Users/NF/Documents/Projects/iranti/src/archivist/index.ts)
- [Decay helpers](/C:/Users/NF/Documents/Projects/iranti/src/lib/decay.ts)
- [Query access tracking](/C:/Users/NF/Documents/Projects/iranti/src/library/queries.ts)
