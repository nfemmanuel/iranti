# Memory Decay

## Overview

Iranti supports an opt-in decay pass in the Archivist based on the Ebbinghaus forgetting curve. The goal is retrieval quality, not storage reduction: stale low-value facts should lose influence over time so recent and repeatedly-used facts dominate retrieval and injected context.

## Formula

The Archivist computes retention as:

`retention = e^(-time_since_access_days / stability)`

Then applies it to the stored original confidence:

`new_confidence = original_confidence × retention`

`original_confidence` is preserved in `knowledge_base.properties.originalConfidence` so repeated maintenance runs do not compound decay against already-decayed values.

## Schema

`knowledge_base` stores:

- `lastAccessedAt`
- `stability`

`lastAccessedAt` records the last time a fact was actually returned to an agent. `stability` grows with repeated access and slows future decay.

## Access Rules

An access is recorded only when a fact is returned or injected to an agent:

- `query()`
- `queryAll()`
- `handshake()` when a fact is included in the working-memory brief
- `observe()` when a fact is returned for injection
- `attend()` indirectly via `observe()`

These do not count as access:

- `search()` results
- Archivist internal reads
- protected Staff reads used for system operation

Each access:

- sets `lastAccessedAt = now()`
- increments `stability` by `IRANTI_DECAY_STABILITY_INCREMENT`
- caps `stability` at `IRANTI_DECAY_STABILITY_MAX`

## Environment Variables

| Variable | Default | Meaning |
|---|---|---|
| `IRANTI_DECAY_ENABLED` | `false` | Enables the Archivist decay pass |
| `IRANTI_DECAY_STABILITY_BASE` | `30` | Starting stability in days |
| `IRANTI_DECAY_STABILITY_INCREMENT` | `5` | Stability increase per access |
| `IRANTI_DECAY_STABILITY_MAX` | `365` | Hard cap for stability |
| `IRANTI_DECAY_THRESHOLD` | `10` | Facts below this confidence are archived |

## Archivist Behavior

When `IRANTI_DECAY_ENABLED=true`, the Archivist:

1. scans active non-protected facts in `knowledge_base`
2. computes decayed confidence from `lastAccessedAt` and `stability`
3. updates confidence in place
4. archives any fact whose decayed confidence drops below `IRANTI_DECAY_THRESHOLD`

Decay never deletes facts. It only lowers confidence or moves facts into the existing archive path.

## Why Opt-In

Decay is disabled by default because some deployments need permanent, non-decaying records for audit, compliance, or legal retention. Enabling decay is a retrieval-quality tradeoff and should be chosen per instance.
