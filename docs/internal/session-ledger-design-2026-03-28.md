# Session Ledger Design Notes — 2026-03-28

## Why this exists

Iranti's shared memory behavior has become stronger than its explainability story.
We now have:

- durable session checkpoints
- first-party `staff_events` emission across API, CLI, Claude hook, and MCP hosts
- `GET /memory/ledger` and `listSessionLedger()` for bounded operator reads

What we still do not have is a final product contract for "full audit log of all sessions".

This note captures the intended direction so the next pass does not have to rediscover it.

## Current contract

The new session ledger is:

- structured
- bounded
- operator-oriented
- derived from `staff_events`

It is **not**:

- a raw transcript store
- a guarantee that every third-party MCP host logs perfectly
- a replacement for durable knowledge in `knowledge_base`

## Desired end state

Iranti should expose a trustworthy session ledger for first-party host paths that can answer:

1. Did a session start with a handshake?
2. Did Iranti decide to inject memory for a turn?
3. Which facts were surfaced and why?
4. Which durable writes or checkpoints were created?
5. What source surface triggered the event (CLI, MCP, Claude hook, API)?
6. Which session id ties the events together?

## Remaining design gaps

### 1. Source truthfulness

Some Attendant events still use coarse `source` values such as `internal`.
We should thread the originating surface more precisely where possible:

- `cli`
- `mcp`
- `claude_hook`
- `api`
- `control_plane`

### 2. Event taxonomy

We need a stable list of event types that are safe to rely on:

- `handshake_completed`
- `attend_completed`
- `observe_completed`
- `checkpoint_written`
- `session_resumed`
- `session_completed`
- `session_abandoned`
- `memory_write_created`
- `memory_write_updated`
- `memory_write_escalated`

Additive expansion is fine, but existing meanings should stay stable within the major version.

### 3. Payload boundaries

The ledger should prefer:

- reasons
- entity ids
- fact keys
- counts
- concise summaries

and avoid storing full raw prompts/responses by default.

The memory ledger is an audit/explainability surface, not a transcript warehouse.

### 4. Retention and noise

The product needs an explicit policy for:

- routine health probes
- system-internal background checks
- noisy debug-only events
- long-term retention vs pruning/export

The current direction is correct:

- suppress routine probe noise at write time when it adds no operator value
- keep meaningful first-party session events queryable

### 5. Cross-host consistency

First-party hosts can be made strong.
Third-party hosts cannot be forced to honor Iranti lifecycle recommendations.

The public contract should therefore distinguish:

- first-party audit coverage: strong and supported
- third-party MCP coverage: best-effort unless the host honors the integration contract

### 6. Control Plane operator surfaces

The current CP Logs page is improving, but a fuller session-ledger surface should eventually support:

- filtering by `sessionId`
- grouping by agent / session
- compact event timeline view
- direct links from session recovery views to the underlying ledger rows

## Suggested next phases

### Phase A — done in this pass

- first-party hosts emit DB-backed `staff_events`
- short-lived hosts flush before exit
- `GET /memory/ledger`
- `listSessionLedger()`

### Phase B

- thread stronger `source` values through Attendant paths
- add stable event taxonomy notes to the public docs
- add CP filtering by `sessionId`

### Phase C

- operator timeline UX in the Control Plane
- retention/export policy
- clear distinction between session ledger and durable shared knowledge
