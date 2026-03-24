# Interrupted Session Recovery

## Overview
Iranti currently persists durable knowledge and the Attendant's last saved brief, but it does not offer first-class recovery for an agent session that dies midway through a task. This feature adds checkpointed task/session recovery so the first handshake after a crash or disconnect can recover interrupted work intentionally instead of merely rebuilding a generic brief from current context.

## Inputs

| Input | Type | Description |
|---|---|---|
| agent id | string | The external agent identity whose session is being resumed. |
| session id | string | Unique identifier for a live agent session or run attempt. |
| task summary | string | Human-readable description of the current workstream. |
| task status | enum | `active`, `completed`, `abandoned`, `interrupted`. |
| checkpoint payload | JSON | Structured progress snapshot: current step, next step, open risks, recent outputs, and relevant entity targets. |
| heartbeat timestamp | datetime | Last known alive timestamp for the session. |
| handshake context | task + recent messages | The returning session's new startup context. |
| recovery policy | config | TTL for stale active checkpoints and task-match recommendation behavior. |

## Outputs

| Output | Type | Description |
|---|---|---|
| persisted attendant state | knowledge entry | Agent-scoped durable brief plus the latest checkpoint and any derived recovery metadata. |
| interrupted-session notice | handshake payload | Clear signal that a prior task appears to have been interrupted. |
| recovery recommendation | handshake payload | Suggested resume action, including last known step and next step. |
| session inspection payload | API response | Current persisted checkpoint/recovery state for one agent, exposed without forcing a new handshake; accepts optional task/recent-message context when an operator wants the same recovery matching logic as a real handshake. |
| session inventory payload | API response | Operator-oriented list of persisted session checkpoints across agents, with filtering and sorting support. |
| resolved recovery state | knowledge entry | Updated agent-scoped checkpoint state after resume, complete, or abandon. |

## Decision Tree / Flow
1. On session start, load or create the agent-scoped attendant state for the agent.
2. During long-running work, persist checkpoint updates at meaningful boundaries:
   - after planning
   - after each finished subtask
   - before expensive external calls
   - before handing work to another agent
3. Store the latest checkpoint inside the persisted attendant state rather than in-memory-only state.
4. If the process exits cleanly and the task is finished, mark the checkpoint completed or abandoned explicitly.
5. If the process disappears without closing the session:
   - detect staleness using heartbeat or last-updated TTL
   - treat the stale active checkpoint as operator-interrupted
6. On the next `handshake()` for that agent:
   - load persisted Attendant state
   - load the latest persisted checkpoint if one exists
   - compare the new handshake task against the checkpoint task fingerprint
7. If the new task strongly matches the interrupted task:
   - include a recovery section in the handshake output
   - provide the last completed step, current checkpoint, and recommended next step
8. If the new task is clearly different:
   - keep the persisted checkpoint visible for audit
   - do not silently force-resume it
9. Operators may inspect the persisted session state directly through `GET /memory/session/:agentId` without triggering a new handshake.
   - raw `sessionCheckpoint.status` remains the persisted checkpoint state
   - derived `summary.operatorState` reflects operator-facing classification such as stale-active -> interrupted
   - optional `task` and `recentMessages` query context lets the route compute the same task-match recovery recommendation as `inspectSession()` / `handshake()`
10. Operators may inventory persisted sessions through `GET /memory/sessions`, including filtered views such as interrupted-only or one-agent-only listings.
11. If the caller explicitly chooses resume:
   - move the checkpoint back into active state
   - continue updating checkpoints throughout execution
12. If the caller explicitly abandons the interrupted work:
   - preserve the checkpoint as historical evidence
   - mark the task abandoned rather than deleting it

## Edge Cases

- `updateWorkingMemory()` alone is not sufficient for recovery because it is in-memory only; checkpoint writes must be durable.
- If no checkpoint exists, handshake and inspection return no recovery recommendation because there is no durable progress snapshot to match.
- Only one latest checkpoint is currently persisted per agent; historical multi-checkpoint inventory for one agent is not yet implemented in this feature.
- If an agent returns with a totally different mission, the prior interrupted task should remain visible but not pollute the new working-memory brief.
- Recovery data should stay agent-scoped by default; cross-agent task recovery should require explicit shared task identifiers rather than implicit leakage.
- If the checkpoint payload is malformed or too large, the system should store a minimal safe summary rather than fail the entire handshake.
- The feature should preserve durable auditability; interrupted work should not disappear just because it was resumed later.

## Test Results

- Implemented in the attendant, SDK, and client surfaces, with a dedicated memory-route inspection endpoint for operator tooling.
- Coverage added for:
  - stale-checkpoint recovery suggestion on handshake
  - `inspectSession()` raw checkpoint vs derived operator summary behavior
  - route-level session inspection with task/recent-message query context
  - explicit checkpoint, resume, complete, and abandon flows
- Exercised by:
  - `tests/session-recovery/run_session_recovery_tests.ts`

## Related

- `src/attendant/AttendantInstance.ts`
- `src/attendant/registry.ts`
- `src/sdk/index.ts`
- `src/api/routes/memory.ts`
- `src/api/middleware/validation.ts`
- `scripts/test-attendant.ts`
- `scripts/test-sdk.ts`
- `tests/typescript_client/smoke_test.ts`
- `docs/decisions/006-runtime-lifecycle-safety.md`
