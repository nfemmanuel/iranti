# Bidirectional Attend

## Overview

`iranti_attend` becomes bidirectional. It already handles retrieval at every phase (pre-response, mid-turn, post-response). This feature adds a capture step at each phase so the same call that pulls relevant memory into context also writes durable facts out of the visible material back into shared memory.

Capture is scoped to observation, not intention. Explicit `iranti_write` remains the strict path for facts the agent knows to preserve. Captured facts are looser (lower confidence, batch-revertable, semantic-deduped against explicit writes).

`iranti_observe` is untouched. It stays a retrieval tool with its current signature. Capture logic lives inside `iranti_attend` and reuses the existing `librarian/chunker.ts` LLM extraction, not a new primitive.

## Per-phase behavior

| Phase | Captures from | Source label | Default |
|---|---|---|---|
| `pre-response` | `latestMessage` (user text) | `observed_from_user` | off |
| `mid-turn` | `toolResult.content` | `observed_from_discovery` | on (replaces existing `attendant_autowrite`) |
| `post-response` | `latestMessage` (assistant reply) OR `findings` | `observed_from_agent` | on |

Pre-response default is off until user-message extraction is validated against noise. Projects opt in via config.

## Inputs (new and changed)

| Input | Type | Description |
|---|---|---|
| `findings` | `string \| undefined` | Optional. Post-response only. Short summary of durable takeaways the agent wants captured. Required path when `latestMessage` exceeds the size threshold. |
| `latestMessage` | `string \| undefined` | Existing. Now doubles as a capture source at pre-response and post-response. |
| `toolResult` | `object \| undefined` | Existing. Continues to drive mid-turn capture. |

No other fields change.

## Outputs (new)

Capture result added to the existing attend response payload.

| Output | Type | Description |
|---|---|---|
| `capture.factsExtracted` | `number` | Candidate facts returned by chunker before dedup. |
| `capture.factsWritten` | `number` | Facts persisted after dedup and confidence blending. |
| `capture.skippedDupe` | `number` | Facts dropped because an `iranti_write` this turn already covered them. |
| `capture.skippedRepeat` | `number` | Facts dropped by session-wide semantic dedup. |
| `capture.skippedBoilerplate` | `number` | Facts dropped by the boilerplate filter. |
| `capture.observedBatchId` | `string` | Batch ID shared across all observed writes in the turn. One-call revert anchor. |
| `capture.sourceLabel` | `string` | `observed_from_user`, `observed_from_discovery`, or `observed_from_agent`. |
| `capture.phase` | `string` | The phase the capture ran in. |

## Decision tree / flow

1. Host calls `iranti_attend` with phase and relevant input fields.
2. Retrieval runs first (unchanged). Facts inject into context per existing logic.
3. Capture step runs next, branching on phase.
4. **Pre-response capture** (if enabled for project):
   1. Take `latestMessage` as input text.
   2. Run boilerplate filter. Skip if the message is a greeting, acknowledgement, or short non-content turn.
   3. Call `chunker.chunkContent()` with entity hints derived from `entityHints` or inferred from message content.
   4. Apply dedup (see Dedup layers below).
   5. Persist survivors with source `observed_from_user`, confidence 70, shared `observedBatchId`.
5. **Mid-turn capture**:
   1. Take `toolResult.content` as input text.
   2. Truncate at 8000 chars (existing behavior).
   3. Run chunker with entity hints derived from `toolResult.metadata.path` or `toolResult.metadata.url`.
   4. Apply dedup.
   5. Persist with source `observed_from_discovery`, confidence 70, shared `observedBatchId`.
6. **Post-response capture**:
   1. If `findings` is present, run chunker on `findings` and skip `latestMessage`.
   2. Else if `latestMessage.length` is under the size threshold, run chunker on `latestMessage`.
   3. Else skip capture and add a note to the response indicating `findings` is required for this turn.
   4. Apply dedup.
   5. Persist with source `observed_from_agent`, confidence 70, shared `observedBatchId`.
7. Capture result block is appended to the attend response and returned to host.

## Size threshold

Post-response extraction only.

| Range | Behavior |
|---|---|
| `latestMessage.length <= 5000` | Chunker runs on raw assistant text. |
| `latestMessage.length > 5000` | Chunker runs on `findings` if provided, else capture skips and response notes the skip. |

Threshold is a single constant in config, default 5000 chars. Configurable per project.

## Dedup layers

Two layers applied before any observed fact is persisted.

1. **Per-turn dedup.** Observed fact is dropped if an `iranti_write` call earlier in the same turn persisted a fact with matching entity plus summary hash. Keeps explicit writes authoritative.
2. **Session-wide dedup.** Observed fact is dropped if a semantic hash (entity plus summary after normalization) exists in the session LRU. On hit, the existing fact's `lastSeen` timestamp bumps. No new write. Cache is scoped to the attendant instance and cleared on session end.

## Confidence

Observed captures default to 70. `iranti_write` defaults to 85. The chunker's existing 70/30 blend with caller confidence still applies. Observed facts cannot climb above 70 even if the LLM extraction returns 100.

## Compliance counter

Observed captures count as half credit toward the "write after every edit" counter. Explicit `iranti_write` remains full credit. Prevents agents from leaning entirely on auto-capture and skipping intentional writes for file edits and confirmed findings.

## Interaction with write guard

The write guard (`.claude/iranti-write-guard-hook.js`) blocks `iranti_attend` until every tracked file edit has a corresponding explicit `iranti_write`. Bidirectional attend does not change this contract.

Rules.

- Explicit `iranti_write` satisfies the guard. No change.
- `observed_from_user`, `observed_from_discovery`, and `observed_from_agent` writes do **not** satisfy the guard, regardless of entity or summary overlap with a pending edit. The guard is about confirming agent intent per edit, not about whether a fact exists in memory.
- The compliance counter's half-credit rule for observed captures is scoped to the compliance metric only. It does not weaken or partially clear the guard.

This keeps observed writes from becoming a backdoor that lets agents skip acknowledging edits.

Implementation note. The guard's pending-list check must compare against `iranti_write` source labels (`implementation`, `user_correction`, etc.) and explicitly exclude any entry whose source starts with `observed_from_`.

Prerequisite. The edit tracker (`.claude/iranti-edit-tracker-hook.js`) currently has hygiene issues that cause the guard to block attend on noise (see `docs/internal/write-guard-tracker-hygiene.md`). Those must be addressed before bidirectional attend ships, or the new capture system will make the existing guard pathology worse.

## Edge cases

- **Empty latestMessage at any phase.** Capture skips without error.
- **Chunker returns zero facts.** Capture writes nothing, emits a zero-counts capture block, no error.
- **Chunker parse failure.** Capture emits `skipped: "parse_failure"` and a reason string. Retrieval still returns normally.
- **Agent calls `iranti_write` and then post-response attend writes a near-duplicate.** Per-turn dedup catches it. Observed fact dropped, counted as `skippedDupe`.
- **Same fact observed across multiple turns in a row.** Session-wide LRU blocks the repeat. `lastSeen` bumps on the existing fact.
- **Oversized assistant response without findings.** Post-response capture skips, returns a `findings_required` hint in the response. No partial extraction from truncated text.
- **Mid-turn toolResult exceeds 8000 chars.** Existing truncation behavior preserved. No change.
- **Pre-response disabled for project.** Capture block is still present in response but all counts are zero and `skipped: "disabled_by_config"`.
- **Revert.** `iranti revert-autowrite <observedBatchId>` removes every observed fact from that turn in one call. Explicit writes in the same turn are untouched.

## Config

| Key | Default | Scope |
|---|---|---|
| `attend.capture.preResponse` | `false` | project |
| `attend.capture.midTurn` | `true` | project |
| `attend.capture.postResponse` | `true` | project |
| `attend.capture.sizeThreshold` | `5000` | project |
| `attend.capture.observedConfidence` | `70` | project |
| `attend.capture.sessionDedupCacheSize` | `256` | project |

## Test plan

- Happy path pre-response capture persists user preferences from a message.
- Happy path mid-turn capture persists file facts from a Read result (covers existing autowrite behavior under new source label).
- Happy path post-response capture persists decisions from assistant reply under the size threshold.
- Post-response over threshold without `findings` skips with `findings_required`.
- Post-response over threshold with `findings` captures from findings and ignores raw reply.
- Per-turn dedup drops an observed fact that matches an explicit `iranti_write` earlier in the same turn.
- Session-wide dedup drops a repeated observed fact and bumps `lastSeen` on the existing fact.
- Boilerplate filter drops greetings, acknowledgements, and tool-noise echoes at pre-response.
- Disabled phase returns zero capture counts without error.
- Revert removes every observed fact from the batch in one call without touching explicit writes.
- Compliance counter increments by 0.5 per observed fact and 1 per explicit write.

## Related

- [iranti_attend source](/c:/Users/NF/Documents/Projects/iranti/src/api/routes/attend.ts)
- [chunker.ts](/c:/Users/NF/Documents/Projects/iranti/src/librarian/chunker.ts)
- [Attendant instance](/c:/Users/NF/Documents/Projects/iranti/src/attendant/AttendantInstance.ts)
- Existing `attendant_autowrite` path in mid-turn attend (to be renamed `observed_from_discovery`).

## Open items for implementer

- Confirm exact location of attend route handler and whether capture belongs in route or AttendantInstance.
- Decide where the session-wide dedup LRU lives (AttendantInstance memory vs shared cache).
- Decide whether `findings` accepts structured JSON or freeform text. Current spec assumes freeform.
- Confirm revert command surface is `iranti revert-autowrite` or a new `iranti revert-observed` command.
