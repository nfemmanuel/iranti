# 006 - Runtime Lifecycle Safety

## Context
Iranti now has long-lived runtime modes beyond one-shot CLI calls:
- API servers
- MCP servers
- hook-driven integrations
- per-agent Attendant state persisted across sessions

Two gaps remain:
1. upgrading packaged installs while Iranti-owned processes are still running is still fragile, especially on Windows
2. if an agent session dies midway through a task, durable knowledge survives but the task's in-flight execution state does not have a first-class recovery model

Both problems are runtime lifecycle issues rather than isolated CLI bugs.

## Decision
Iranti should treat runtime lifecycle as a first-class product surface.

Specifically:
- packaged runtime upgrades should use staged side-by-side installation plus supervised restart or handoff, not in-place mutation of the live install directory
- interrupted agent sessions should gain explicit checkpoint-based recovery rather than relying only on the last persisted Attendant brief
- the first handshake after return should be able to surface an interrupted-session recovery recommendation when durable checkpoint data exists

## Consequences
Good:
- upgrades become safer and more predictable on Windows and other platforms with live-process file locking
- operators get a coherent model for "new version staged but not yet activated"
- interrupted agent work becomes more recoverable and auditable
- handshake becomes a stronger session-resumption primitive rather than just a brief rebuild

Bad:
- runtime metadata and process supervision become more complex
- checkpointing introduces more durable state that must be pruned and governed
- client reconnect behavior must be handled explicitly for MCP and other long-lived integrations

## Alternatives Considered
- Keep trying to replace the live packaged install in place
  - Rejected because it is brittle, especially on Windows, and does not scale to long-lived runtime modes.

- Accept that interrupted tasks are out of scope because Iranti is only memory infrastructure
  - Rejected because durable mid-task recovery is becoming part of the real operator expectation for agent memory systems.

- Add zero-downtime hot swap as the first implementation target
  - Rejected because staged upgrade plus supervised restart is a simpler and more defensible first product step.
