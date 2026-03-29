# Session Ledger Contract - 2026-03-28

## Why this matters

Iranti is already good at storing durable facts and increasingly good at
retrieving them. What it still lacks is a trustworthy, canonical account of
how memory was used while work was happening.

That gap matters more now because Iranti is no longer only serving one host.
We already have:

- CLI flows
- Claude hook flows
- MCP flows used by Codex and other clients
- API and Control Plane paths

And we expect to add more:

- Gemini
- Amazon Q
- GitHub Copilot
- Cline

As those host surfaces grow, compaction and multi-agent handoff become normal.
Future agents must be able to recover engineering knowledge about:

- what host path worked
- what host path failed
- what memory was injected
- what was persisted
- what was skipped and why
- what operational conclusions were learned while debugging Iranti itself

The session ledger is the missing layer that should let Attendant recover that
knowledge without forcing future agents to re-read the repo, terminal history,
and old chats every time.

## What the session ledger is

The session ledger is:

- structured
- bounded
- queryable
- host-aware
- operator-readable
- compatible with Attendant recovery

The session ledger is not:

- a raw transcript store
- a replacement for `knowledge_base`
- a place to mirror every token or tool call
- a dumping ground for low-value background health probes

The ledger should explain meaningful memory behavior, not replay the entire
conversation verbatim.

## Core product goals

The ledger should make these questions answerable for first-party host paths:

1. Did the session start cleanly?
2. Was handshake performed, skipped, or auto-bootstrapped?
3. Did attend decide memory was needed?
4. Which facts were injected, and for what reason?
5. Which exact/shared operations were used to answer the turn?
6. Which writes, summaries, checkpoints, or shared breadcrumbs were created?
7. What failed, and what fallback happened instead?
8. Which host surface produced the event?
9. Which project binding and session id tie the activity together?
10. What durable engineering lesson should a future agent recover after compaction?

## Contract boundary: ledger vs durable knowledge

Iranti should keep a clear separation between:

### Durable knowledge in `knowledge_base`

Use `knowledge_base` for:

- facts
- decisions
- blockers
- next steps
- current step
- important artifacts
- preferences
- stable project constraints
- explicit handoff facts

### Session ledger in `staff_events`

Use `staff_events` for:

- structured explanation of memory behavior
- host lifecycle activity
- retrieval and injection decisions
- write/checkpoint/summary attempts
- failures and fallbacks
- bounded operational context for later recovery

The same situation may produce both:

- a ledger row explaining that a checkpoint happened
- durable shared facts like `checkpoint_next_step`

That is correct. The ledger explains the behavior; the KB holds the durable
truth that other agents can read directly.

## Canonical event families

The ledger should converge on a stable set of event families. New events can be
added later, but the meaning of these should stay stable.

### Session lifecycle

- `session_started`
- `session_resumed`
- `session_completed`
- `session_abandoned`
- `session_recovered`

### Memory preparation

- `handshake_completed`
- `handshake_auto_bootstrapped`
- `reconvene_completed`

### Turn-time retrieval

- `attend_completed`
- `observe_completed`
- `memory_injected`
- `memory_not_injected`
- `mandatory_recall_forced`

### Direct read operations

- `query_executed`
- `search_executed`
- `related_executed`
- `related_deep_executed`
- `whoknows_executed`

### Durable write operations

- `write_created`
- `write_updated`
- `write_replaced`
- `write_escalated`
- `ingest_completed`
- `summary_written`
- `checkpoint_written`
- `checkpoint_shared_breadcrumb_failed`

### Host/operational failures

- `host_failure`
- `provider_fallback_used`
- `ledger_emit_failed`
- `integration_probe_failed`

The current implementation already has some of these and some nearby variants.
The next implementation passes should normalize existing names toward this
contract rather than inventing a parallel vocabulary.

Recent implementation note:

- first-party host paths now emit explicit `host_failure` rows on fatal MCP and
  Claude hook exits when a DB-backed emitter is installed
- first-party completion paths can emit `provider_fallback_used`
- handshake recovery now prefers bounded synthesized lessons such as:
  - host reliability lessons
  - recall-policy lessons
  - persistence lessons

This keeps the ledger more useful after compaction than a pile of isolated raw
rows would be.

## Required fields for every ledger row

Every meaningful first-party ledger row should carry:

- `eventId`
- `timestamp`
- `staffComponent`
- `actionType`
- `agentId`
- `source`
- `level`
- `metadata.sessionId`

And where applicable:

- `entityType`
- `entityId`
- `key`
- `reason`
- `metadata.projectEnv`
- `metadata.instance`
- `metadata.host`
- `metadata.shouldInject`
- `metadata.factCount`
- `metadata.injectedKeys`
- `metadata.error`
- `metadata.fallback`

## Source / host truthfulness

This is one of the biggest current weaknesses.

Today some Attendant paths still emit `source: internal`, which is not enough.
The ledger contract should distinguish at least:

- `cli`
- `mcp`
- `claude_hook`
- `chat`
- `api`
- `control_plane`
- `internal_background`

And `metadata.host` should be able to distinguish the calling host family when
it is known:

- `claude_code`
- `codex_cli`
- `codex_vscode`
- `control_plane`
- `plain_cli`
- `api_client`
- `generic_mcp`

This is important because "worked in Codex CLI but not Codex VS Code" is a real
engineering fact worth recovering after compaction.

## Per-host obligations

### CLI

Must emit:

- `session_started` or `handshake_completed`
- direct read operations when they materially informed the command
- `checkpoint_written` / `summary_written` / write events
- `host_failure` on operational failures

### Claude hook

Must emit:

- `handshake_completed` on `SessionStart`
- `attend_completed`
- `memory_injected` or `memory_not_injected` on `UserPromptSubmit`
- `summary_written` on narrow Stop writes
- `checkpoint_written` when Stop creates shared progress breadcrumbs

### MCP server

Must emit:

- `handshake_completed` when the host calls it
- `handshake_auto_bootstrapped` when `attend` had to recover a missed handshake
- direct read and write operations through the MCP tool surface
- `host_failure` when tool execution fails in a host-significant way

### Chat host

Must emit:

- `session_started`
- `handshake_completed`
- `attend_completed`
- meaningful direct read/write events

### API / Control Plane

Must emit:

- operator-significant activity
- not noisy internal probe churn
- integration probe failure/success where that changes operator understanding

## Noise policy

The ledger should explicitly suppress:

- routine health probes with no operator value
- repeated "memory not needed" debug spam when the event is purely internal and not tied to a meaningful host turn
- low-signal background checks

The ledger should keep:

- first meaningful turn-time retrieval decisions
- writes
- summaries
- checkpoints
- fallbacks
- failures
- forced recall decisions
- host integration failures

The goal is not "log everything". The goal is "make future recovery trustworthy".

## Attendant recovery contract

Attendant should eventually treat the session ledger as a recovery source for:

- recent host failures
- proven integration behaviors
- prior successful host patterns
- what memory decisions happened in a recent session
- why an agent concluded a host path was good or bad

Attendant should not dump raw ledger rows into working memory.

Instead it should synthesize:

- host health summaries
- recent session outcome summaries
- unresolved operational risks
- last-known-good integration pattern per host

Examples:

- "Claude hook path already proved handshake + attend + stop checkpointing work for this repo."
- "Codex VS Code depends on `.vscode/mcp.json`; prior failures were missing workspace MCP config."
- "Control Plane MCP initialize probe was previously false-negative until the SDK-based probe replaced the hand-rolled stdio timeout check."

This is the bridge between "audit log" and "useful shared engineering memory".

## Relationship to checkpoint facts

Checkpoint facts and session ledger rows are complementary:

- `checkpoint_*` in `knowledge_base` are resumable shared breadcrumbs
- `checkpoint_written` in the ledger explains when, how, and from which host those breadcrumbs were produced

Future Attendant recovery should be able to use both:

- checkpoint facts for the latest shared state
- session ledger for the why/how/host context

## Phase plan

### Phase 1: contract hardening

- stabilize event taxonomy names
- thread truthful `source` and `metadata.host`
- document required metadata fields
- update tests so first-party host paths are checked against the contract

### Phase 2: first-party host completeness

- CLI
- Claude hook
- MCP server
- chat
- API / Control Plane

Goal:
- every first-party host emits the minimal canonical ledger backbone

### Phase 3: Attendant recovery integration

- add ledger summarization helper(s)
- let handshake/recovery load recent host/integration learnings
- keep it bounded and filtered, not row-dump-heavy

### Phase 4: operator UX

- session timeline in Control Plane
- filter by session id / host / agent
- show meaningful summary rows first
- allow drill-down into metadata when needed

## Immediate implementation priorities

1. Thread `source` and `metadata.host` accurately through Attendant paths.
2. Normalize the current event taxonomy around the canonical families above.
3. Add explicit events for:
   - `memory_injected`
   - `memory_not_injected`
   - `query_executed`
   - `search_executed`
   - `checkpoint_written`
   - `summary_written`
4. Add contract coverage for all first-party hosts.
5. Teach Attendant to recover a small bounded "recent host learnings" brief from the ledger.

## Release posture

This should be released in stages.

Do not wait for a perfect operator timeline UI before shipping the contract
hardening. The main value comes from making the host activity trustworthy and
recoverable in the first place.

But also do not expand to more host integrations until:

- Iranti itself is hardened and deeply tested
- Control Plane rough edges are cleaned
- the ledger contract is solid enough that we do not keep rediscovering host-specific failures from scratch

## Current summary

Iranti now has:

- durable fact memory
- shared checkpoints
- bounded ledger reads
- broader first-party event emission

What it still needs is:

- a stronger canonical ledger contract
- truthful host/source metadata
- Attendant recovery from that ledger

That is the next serious systems step before host-surface expansion.
