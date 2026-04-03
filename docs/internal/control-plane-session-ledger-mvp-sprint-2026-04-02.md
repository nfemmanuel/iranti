# Control-Plane Session Ledger MVP Sprint

## Goal

Turn the current per-instance session ledger into a true control-plane-visible
multi-instance ledger without changing Iranti's local source of truth.

The MVP should let an operator answer:

- what happened across all registered instances
- which host surface produced the event
- which instance, agent, session, and entity were involved
- what failed, what succeeded, and what fallback happened

## Product Position

This sprint does **not** replace the per-instance `staff_events` ledger.

Instead, it adds a control-plane mirror that ingests bounded ledger rows from
each instance and exposes a fleet-wide operator surface.

## Why This Shape

Iranti already has:

- per-instance `staff_events`
- bounded ledger reads via `GET /memory/ledger` and `listSessionLedger()`
- idempotent `staff_events` bootstrap when the table is missing

That means the fastest safe path is:

1. keep runtime writes local
2. poll each instance for new ledger rows
3. mirror those rows into the control plane
4. query the mirror from the control plane UI/API

This avoids coupling runtime event emission to control-plane availability.

## MVP Scope

### In Scope

- mirror table in the control plane DB
- per-instance ingestion watermark tracking
- poller that ingests new ledger rows from each registered instance
- fleet-wide control-plane read surface
- basic filters: instance, host, source, agent, session, action type, time range
- ingestion health visibility per instance
- idempotent ingestion
- minimum operator UI or JSON view for recent activity

### Out Of Scope

- push streaming from instances to the control plane
- rewriting Iranti runtime emitters
- transcript storage
- full analytics pipeline
- retention/archival beyond a simple bounded retention rule
- global cross-instance write paths back into instance ledgers

## Architecture

### Existing Runtime Side

Each Iranti instance continues to:

- emit meaningful first-party events into local `staff_events`
- expose ledger reads through the existing memory/session-ledger surfaces

### New Control-Plane Side

The control plane adds:

1. `mirrored_staff_events`
2. `instance_ledger_watermarks`
3. a poller job
4. a fleet query API
5. a simple operator view

## Data Model

### mirrored_staff_events

Columns:

- `id` - local surrogate primary key
- `instance_id` - control-plane instance identifier
- `remote_event_id` - original `staff_events.event_id`
- `timestamp`
- `staff_component`
- `action_type`
- `agent_id`
- `source`
- `entity_type`
- `entity_id`
- `key`
- `reason`
- `level`
- `metadata`
- `ingested_at`

Required unique constraint:

- `(instance_id, remote_event_id)`

Recommended indexes:

- `(timestamp desc)`
- `(instance_id, timestamp desc)`
- `(source, timestamp desc)`
- `((metadata->>'host'), timestamp desc)`
- `((metadata->>'sessionId'), timestamp desc)`
- `(action_type, timestamp desc)`
- `(agent_id, timestamp desc)`

### instance_ledger_watermarks

Columns:

- `instance_id` - primary key
- `last_timestamp`
- `last_remote_event_id`
- `last_poll_started_at`
- `last_poll_completed_at`
- `last_success_at`
- `last_error_at`
- `last_error_summary`
- `consecutive_failures`

The watermark should advance only after successful persistence of the fetched
batch.

## Poller Contract

### Source Read

For each registered instance:

1. read the current watermark
2. call the instance ledger read surface with:
   - `since`
   - bounded `limit`
3. sort deterministically by:
   - `timestamp`
   - `eventId`
4. upsert into `mirrored_staff_events`
5. advance watermark to the last successfully persisted row

### Batch Rules

- use small bounded batches, e.g. `250`
- if a batch is full, continue immediately until drained
- if the instance is unreachable, record poll failure without advancing watermark
- if the instance returns duplicates, rely on the unique constraint

### Deterministic Resume Rule

When `timestamp` ties occur, the poller must use `remote_event_id` as the
secondary ordering key so no rows are skipped or replayed ambiguously.

## Fleet API

Add a control-plane operator endpoint such as:

- `GET /api/session-ledger`

Supported filters:

- `instanceId`
- `source`
- `host`
- `agentId`
- `sessionId`
- `actionType`
- `since`
- `until`
- `limit`

Response should be plain operator JSON and include:

- rows
- total returned
- whether more rows are available

Add a health endpoint or section such as:

- `GET /api/session-ledger/ingestion-health`

This should return, per instance:

- last success time
- last failure time
- consecutive failures
- latest watermark
- latest error summary

## Minimum UI

The MVP UI can stay intentionally small.

One screen is enough:

- recent fleet ledger stream
- filter bar
- per-row host/source/action/session metadata
- ingestion health summary by instance

Nice-to-have in MVP if cheap:

- click a row to expand `metadata`

## Source/Host Normalization

Do not block MVP on perfect taxonomy cleanup.

MVP should ingest what exists today, while normalizing the obvious stable fields:

- `source`
- `metadata.host`
- `metadata.sessionId`

Normalization rules should be additive:

- preserve raw values
- optionally derive `normalized_source`
- optionally derive `normalized_host`

This keeps ingestion robust even if older instances still emit slightly uneven
labels.

## Sprint Breakdown

### Slice 1 - Control-plane schema

Deliver:

- `mirrored_staff_events` migration
- `instance_ledger_watermarks` migration
- indexes and uniqueness constraints

Acceptance:

- migrations apply cleanly
- duplicate `(instance_id, remote_event_id)` insert is rejected or safely ignored

### Slice 2 - Poller foundation

Deliver:

- polling service per registered instance
- deterministic batching and watermark advancement
- failure tracking

Acceptance:

- one seeded test instance with known ledger rows ingests into the mirror
- rerunning the same poll does not duplicate rows

### Slice 3 - Fleet query API

Deliver:

- `GET /api/session-ledger`
- `GET /api/session-ledger/ingestion-health`

Acceptance:

- operator can filter by instance, host, action type, and session
- API returns stable ordering and bounded rows

### Slice 4 - Minimum operator surface

Deliver:

- recent ledger page or debug view
- instance ingestion health panel

Acceptance:

- operator can identify which instance/host produced a failure
- operator can inspect expanded metadata for one row

### Slice 5 - Validation

Deliver:

- integration test for ingestion from multiple instances
- duplicate-safe replay test
- unreachable-instance watermark preservation test
- same-timestamp ordering test

Acceptance:

- two instances with overlapping timestamps ingest without gaps
- failed poll does not advance the watermark
- replay does not create duplicates

## Test Matrix

### Required

- schema migration test
- idempotent upsert test
- multi-instance ingestion test
- watermark resume test
- tied timestamp ordering test
- unreachable instance test
- malformed metadata tolerance test

### Good First Operator Scenarios

- "show me all `host_failure` rows across the fleet in the last 24h"
- "show me only `codex_vscode` rows"
- "show me everything for one `sessionId`"
- "show me all `checkpoint_written` rows for one instance"

## Risks

### Risk: noisy fleet stream

Mitigation:

- mirror only meaningful existing ledger rows
- preserve current noise policy
- start with bounded default limits

### Risk: old instances emit inconsistent source/host labels

Mitigation:

- preserve raw fields
- add derived normalized fields without discarding originals

### Risk: ingest gaps on timestamp ties

Mitigation:

- watermark on `(timestamp, remote_event_id)`, not timestamp alone

### Risk: control-plane outages create backlogs

Mitigation:

- runtime ledger remains local source of truth
- poller catches up later from watermark

## Definition Of Done

The MVP is done when:

- at least two instances can be ingested into one control-plane mirror
- duplicate polls do not duplicate rows
- control plane can show a fleet-wide recent ledger stream
- operators can filter by instance, host, session, and action type
- ingestion health by instance is visible
- no runtime write path depends on control-plane availability

## After MVP

Next likely steps:

1. push-based near-real-time forwarding
2. stronger source/host taxonomy normalization
3. retention policy for mirrored ledger rows
4. aggregated lessons and alerting on top of the mirror
5. CP-native views for recovery hotspots, repeated host failures, and under-logged sessions
