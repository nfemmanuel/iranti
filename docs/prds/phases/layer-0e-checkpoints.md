# PRD: Layer 0e — Checkpoint Criteria & Project-State Rollup

**Status:** shipped
**Phase:** Layer 0e (YC foundation) · **Date:** 2026-07-03 · **Author:** Claude Fable 5 (overnight build)
**Related:** master PRD §9 (Features), docs/specs/memory-storage/checkpoints.md, docs/prds/phases/layer-0-foundation.md §11, docs/decisions/open-decisions.md (AX-7)

Pre-authorized by the overnight build mandate — this PRD is written PRD-first (before code) and accepted directly per that mandate, with the acceptance noted in the changelog below rather than awaiting separate sign-off.

---

## 1. Summary

Checkpoints already exist (`src/library/checkpoints.ts`, `iranti_checkpoint`): a checkpoint is a fact with the reserved key `"checkpoint"`, one per entity, upserted with automatic archival of the previous value. This phase adds two things on top of that existing primitive, without a schema migration:

1. **Deterministic checkpoint criteria + a stage/status vocabulary** — carried as checkpoint *metadata* (not a new state machine), so "what stage is this checkpoint at" is answerable without inventing new tables or LLM judgment calls.
2. **A project-state rollup** — a deterministic answer to "where did we left off?" for a project, derived from data already being written (checkpoints, `decision:*` facts, `issue:*` facts, session activity), exposed as a new MCP tool and surfaced automatically in `iranti_attend` on the first attend of a session when there has been a long gap since last activity.

## 2. Problem & motivation

Today, a checkpoint is a single free-text blob. It answers "what were you doing" but not "what stage is that work at" or "what else is outstanding in this project" without the agent manually re-deriving it from a facts dump. After a long gap (a user returns after days/weeks), there is no single deterministic answer that names the state — the agent must re-run `iranti_search`/`iranti_history` calls and reconstruct it by hand, which is exactly the kind of work iranti exists to remove.

## 3. Goals & non-goals

- **Goals:**
  - Define, deterministically, what makes a checkpoint "checkpoint-worthy" (primarily: an explicit host tool call — no LLM judgment).
  - Define a small, closed stage/status vocabulary and where it lives (checkpoint fact metadata).
  - Provide a deterministic project-state rollup: latest checkpoint (+ stage/status), recent decisions, recent open issues, last-activity timestamp, and a computed "gap since last activity."
  - Expose the rollup via a new `iranti_project_state` MCP tool.
  - Surface the rollup automatically in `iranti_attend`'s first call of a session when a deterministic gap threshold is exceeded.
  - Prove correctness across a real restart (module-reset pattern) and prove project isolation.
- **Non-goals:**
  - No LLM-based "is this checkpoint-worthy" trigger (G1 — determinism only; explicitly instructed as out of scope for this phase).
  - No dedicated `checkpoints` table (the existing PRD comment in checkpoints.ts already earmarks this as a later "Phase 2" migration once usage patterns are clearer — not this phase).
  - No new harness corpus dimension (checkpoints don't fit the transcript-probe model; the corpus already churned twice tonight).
  - No escalations in the rollup (see §5, decision 5).
  - No auto-checkpoint-on-inactivity or any wall-clock-triggered background job — gap detection is computed lazily and deterministically at read time (attend/rollup call), never via a timer/daemon.

## 4. Scope

- **In:**
  - `src/library/checkpoint-state.ts` — stage/status vocabulary, metadata shape, and `writeCheckpoint` metadata helper.
  - `src/library/project-state.ts` — the rollup: `getProjectState(project, opts)`.
  - `src/mcp/tools/project-state.ts` — `iranti_project_state` MCP tool + registration in `src/mcp/register.ts`.
  - `iranti_checkpoint` tool gains optional `stage` / `status` inputs (backward compatible — both optional, existing callers unaffected).
  - `iranti_attend` gains a `projectState` field on its response, populated only on the first attend of a session (or when explicitly requested) AND only when the gap-since-last-activity threshold is exceeded.
  - `src/tests/project-state.test.ts` — scripted host-simulation efficacy suite (mirrors `host-simulation.test.ts`'s pattern, separate file).
- **Out (deferred):**
  - Dedicated `checkpoints` table — deferred to whenever real usage data calls for it (per the existing header comment in checkpoints.ts).
  - Escalations in the rollup — deferred; see §5 decision 5 for why.
  - Any UI/CLI surface for the rollup beyond the MCP tool + attend field.
  - Auto-checkpoint triggers based on tool-call-shape heuristics beyond the explicit call — flagged as a future idea in §9, not built.

## 5. Design decisions & rationale

**Decision 0 — AX-7 grounding correction (read this first).** The build brief for this phase assumed "AX-7 status-as-checkpoint-tag principle" is a named, existing principle in this codebase. It is not. Grepping `docs/` for `AX-7` found exactly one meaning: `docs/decisions/open-decisions.md`'s augmentation-experiments table defines **AX-7 = "transient-vs-durable fact gate"** ("stop storing volatile facts like `typecheck_status=clean`"), status **not started**. There is no "status-as-checkpoint-tag" AX entry anywhere in `docs/` or `src/`. Rather than invent a citation, this PRD:
  - Does NOT claim AX-7 as the source of the status-as-tag idea.
  - Grounds the actual idea instead in what already exists: `checkpoints.ts`'s own design note ("a checkpoint is a fact with the reserved key `checkpoint`... This costs zero schema changes and inherits all fact behavior for free") — i.e., iranti already treats checkpoint *state* as data riding on the existing fact/metadata substrate rather than a parallel state machine. This phase extends that same posture to stage/status: **status lives in the checkpoint fact's `metadata` jsonb column**, not a new table, not a new enum column, not a state machine with its own transitions table.
  - Flags this explicitly in the acceptance criteria and final report so a reviewer isn't misled into thinking AX-7 says something it doesn't.

**Decision 1 — Checkpoint criteria stay explicit-call-only; no new deterministic auto-trigger this phase.**
Alternatives considered: (a) explicit `iranti_checkpoint` call only (status quo); (b) an auto-checkpoint fired when a deterministic tool-call-shape signal fires (e.g., N facts written since last checkpoint, or an `issue:*` fact transitions to `resolved`); (c) LLM-judged "this feels like a good checkpoint moment."
(c) is rejected outright — G1 forbids LLM-based triggers for a structural memory operation; a checkpoint's existence must be reproducible from the same inputs every time.
(b) is tempting but was rejected for THIS phase: every candidate deterministic trigger (issue resolved, N facts written, session about to close) either (i) has no reliable "session about to close" signal in a stdio MCP server (the host can SIGKILL at any time — `context.ts`'s own comment: "hosts typically kill the server process rather than shutting it down gracefully"), or (ii) risks writing a checkpoint that overwrites a richer human-authored one with a thin auto-generated summary, which is a regression on the "one checkpoint per entity, upsert semantics" contract. Auto-checkpointing deserves its own measured PRD (a real trigger needs a real "is this better than what's there" check) — flagged as future work in §9, not built now.
So: (a) stays primary and is the only trigger in this phase. The "criterion" for checkpoint-worthiness is unchanged and deterministic: the host calls `iranti_checkpoint` explicitly.

**Decision 2 — Stage/status vocabulary: small, closed, stored as metadata.**
`iranti_checkpoint` gains two new optional fields:
  - `stage: "planning" | "in_progress" | "blocked" | "done"` (default: `"in_progress"` when omitted — matches the common case of "I'm mid-task, here's where I am").
  - `status: string` (short free-text substatus, e.g. "waiting on API key", optional, no default) — deliberately NOT a closed enum, because sub-status text is exactly the kind of nuance a fixed vocabulary would force-fit; the `stage` enum carries the deterministic, machine-checkable part, `status` carries the human-legible detail.
Alternative rejected: a full task/state-machine with defined transitions (planning → in_progress → blocked → done → ...) and transition validation. Rejected because it re-introduces the "parallel state machine" iranti's own design principle argues against (see Decision 0) — the checkpoint is a snapshot, not a workflow engine, and enforcing transition legality is scope the brief never asked for and no consumer needs yet.
Storage: `metadata: { stage, status, stageSetAt }` on the checkpoint fact row (the existing `facts.metadata` jsonb column — zero schema change). `stageSetAt` (ISO timestamp) is stamped by the write path itself (not caller-supplied) so it is trustworthy for gap/staleness computation without believing client-supplied clocks.

**Decision 3 — Project-state rollup derives from existing tables; no migration.**
The rollup needs: (a) the latest checkpoint(s) in the project, (b) recent decisions, (c) recent open items, (d) last activity timestamp, (e) a deterministic gap flag.
- (a) is `findFact`/a project-scoped query over `facts` for `key = 'checkpoint'`, i.e. exactly what `getActiveCheckpoint` already does, generalized to "all checkpoints in project" rather than "checkpoint for these entity hints" (a rollup doesn't have entity hints — it's project-wide).
- (b) "recent decisions" = facts whose key starts with `decision:` (the existing extractor convention — see `src/extract/index.ts`'s `DECISION_PATTERNS`, category prefix `decision:`), most recent N by `updatedAt`, project-scoped.
- (c) "recent open items" = facts whose key starts with `issue:` (the `iranti_write_issue` convention) whose JSON value's `status` is NOT `resolved`/`wont_fix`, most recent N by `updatedAt`, project-scoped.
- (d) last activity timestamp = `MAX(updatedAt)` across all non-archived facts in the project's effective scope (a cheap aggregate query, already indexed via the existing `facts_tenant_project_entity_key_uniq`-adjacent access patterns — no new index needed at this data scale; flagged in §9 if this becomes a hot path).
- (e) gap = `now - lastActivity > GAP_THRESHOLD_MS`. Threshold defaults to 4 hours (`IRANTI_PROJECT_STATE_GAP_MS` env override, mirroring the `IRANTI_TOKEN_BUDGET` pattern in `attend.ts`) — chosen as "longer than a lunch break, shorter than a full day," a genuinely arbitrary but *stated* number, easy to override, not hidden. "now" is **injectable** (see Decision 4) so tests never depend on wall-clock sleep.
Alternative rejected: a new `checkpoints` or `project_state_snapshots` table. Rejected because everything the rollup needs already exists as queryable rows in `facts` + `sessions`; adding a table would mean a migration (0015) and a second source of truth to keep in sync with the fact-based checkpoint — a straightforward violation of "prefer deriving over storing" when derivation is this cheap. No migration ships in this phase.
Escalations were considered for "open items" and explicitly excluded: `escalations` has no `project` column today (only `tenantId`) and no project-scoped reader exists. Joining through `existingFactId → facts.project` would work for escalations that have a captured `existingFactId`, but not for a first-conflict-ever escalation (existingFactId is present in the current schema for existing-fact conflicts, so this is actually always populated when `createEscalation` fires from `writeFact`'s conflict path) — however, adding this join is new surface not asked for in the brief, and expanding rollup scope to a second, differently-scoped table increases leak risk without a proven need. Deferred; noted in §9.

**Decision 4 — Gap detection is injectable, not wall-clock-real.**
`getProjectState` accepts an optional `now: Date` (defaults to `new Date()`). This is the only way to make "long gap" deterministically testable without a real sleep — the efficacy suite in §10 calls `getProjectState(project, { now: farFutureDate })` after a module-reset "restart" to simulate "reopened after a long gap" without the test taking hours. This mirrors no existing pattern verbatim but follows the same spirit as `persistence.test.ts`'s module-reset restart simulation (fake the boundary condition structurally, not by waiting).

**Decision 5 — Exposure: new MCP tool + attend surfacing, both project-scoped.**
- `iranti_project_state` — a new, standalone MCP tool. Callable anytime, not just after a gap; this is the direct "where did we leave off" query a host can call on demand (e.g., a host's own "resume session" UI action).
- `iranti_attend` — the `AttendResult` interface gains `projectState: ProjectStateSummary | null`. It is populated **only** when: (i) this is the first `attend()` call in the current process AND (ii) the computed gap exceeds the threshold. This avoids dumping the rollup on every single turn (same "don't inject something every turn regardless of relevance" principle Layer 0d already established for rules) while guaranteeing exactly the scenario asked for: a brand-new session, after a long gap, gets the answer without having to ask.
Both paths are always scoped through `getEffectiviveProjectIds`/the current project exactly like every other read in `attend.ts` — the rollup reuses the SAME project-scoping helpers as the rest of the file (`getEffectiveProjectIds(currentProject)`), so there is no new isolation mechanism to get wrong.

**Decision 6 — "First attend of a session" detection.**
Reuses the exact mechanism `context.ts` already has: `ensureContext()` is a per-process singleton (`current`/`pending` module state) that resolves once per process. `attend()` is given a boolean "is this the first attend since context was established" by checking `session.turnCount === 0` BEFORE `incrementTurnCount` fires (turnCount is already incremented fire-and-forget on every attend — see `sessions.ts`). This needs no new state: turnCount is already exactly "how many attends has this session seen," and checking it in the synchronous part of `attend()` (before the async post-chain) means the first call reliably sees `0`.

## 6. Schema / API changes

**Schema:** none. No migration. `facts.metadata` (existing jsonb column) carries `{ stage, status, stageSetAt }` for checkpoint-key facts only.

**`iranti_checkpoint` (updated input):**
```
entityType, entityId, text        (unchanged)
stage?: "planning" | "in_progress" | "blocked" | "done"   (new, optional, default "in_progress")
status?: string                                            (new, optional, no default)
surface?, agentName?              (unchanged)
```
Result gains `stage` and `status` echoed back.

**`iranti_project_state` (new tool):**
```
input:  { agentName?: string }   // project is always the server's resolved current project — never caller-suppliable, to prevent cross-project probing
output: ProjectStateSummary       // see below
```

**`ProjectStateSummary` shape:**
```ts
{
  hasActivity: boolean;                 // false => "no state yet" clean case
  latestCheckpoint: {
    entity: string; text: string; stage: string; status: string | null; updatedAt: string;
  } | null;
  recentDecisions: Array<{ entity: string; key: string; value: string; updatedAt: string }>;
  openItems: Array<{ entity: string; key: string; title: string; status: string; priority: string; updatedAt: string }>;
  lastActivityAt: string | null;
  gapMs: number | null;                 // null when hasActivity is false
  isLongGap: boolean;                   // gapMs > threshold
}
```

**`iranti_attend` (`AttendResult`):** gains `projectState: ProjectStateSummary | null` — `null` except on the first attend of a session with a long gap.

## 7. Acceptance criteria

- [ ] `iranti_checkpoint` accepts optional `stage`/`status`, stores them in `metadata`, defaults `stage` to `in_progress`, stamps `stageSetAt` server-side.
- [ ] Stage/status live in existing `facts.metadata` — no new table, no migration.
- [ ] `getProjectState(project, { now? })` returns a deterministic `ProjectStateSummary` derived from `facts` (checkpoint / `decision:*` / `issue:*` keys) and is project-scoped using the same `getEffectiveProjectIds` helper as the rest of the codebase.
- [ ] `now` is injectable; no test relies on a real sleep to simulate a gap.
- [ ] `iranti_project_state` MCP tool registered and returns the summary for the current project only.
- [ ] `iranti_attend` surfaces `projectState` on the first attend of a session when the gap exceeds `IRANTI_PROJECT_STATE_GAP_MS` (default 4h); `null` otherwise.
- [ ] Empty project (`hasActivity: false`) returns a clean summary, never throws.
- [ ] Cross-project isolation: project B's rollup never contains project A's checkpoints, decisions, or issues, even with colliding entity ids (mirrors `projects-isolation.test.ts` / host-simulation.test.ts's isolation test pattern).
- [ ] A scripted host-simulation efficacy test proves: real work happens → checkpoint with stage/status written → session "restarts" (module reset) → rollup names the exact latest checkpoint, its stage/status, and recent decisions, with exact assertions (not just "is defined").
- [ ] All mandatory gates pass (see final report).

## 8. Deltas from the master PRD

None. This phase is additive to the existing checkpoints spec (`docs/specs/memory-storage/checkpoints.md`) and does not change any Layer 0 isolation invariant — it reuses `getEffectiveProjectIds` verbatim rather than introducing a new scoping rule.

One correction is recorded (see §5 Decision 0): the build brief's claim that "AX-7" names a "status-as-checkpoint-tag principle" does not match `docs/decisions/open-decisions.md`, where AX-7 is defined as the transient-vs-durable fact gate (status: not started). This PRD does not cite AX-7 for the status-as-tag idea; it grounds that idea in `checkpoints.ts`'s existing "fact with a reserved key, zero schema change" design note instead.

## 9. Risks & open questions

- **Open:** should `lastActivityAt`'s `MAX(updatedAt)` aggregate get a dedicated index once projects grow large? Not needed at current data volumes (single-user, Layer 0 scale) — flagged for revisit if `iranti_project_state` shows up in profiling.
- **Deferred:** escalations are not part of the rollup (Decision 3). If "open items" should include unresolved escalations, that's a follow-up PRD, not a silent scope-add here.
- **Deferred:** deterministic auto-checkpoint triggers (Decision 1) — a real candidate is "an `issue:*` fact's status flips to `resolved`," but this needs its own measured PRD (does it produce checkpoints users actually want, or noise?) rather than being smuggled into this one.
- **Deferred:** a dedicated `checkpoints` table remains future work per the pre-existing note in `checkpoints.ts` — this phase does not revisit that decision.
- **Risk:** the `stage` default of `in_progress` for checkpoints written before this phase shipped means historical checkpoints will read back with `stage: null` (no metadata) rather than a real value — the rollup and tool must treat `metadata` absence as "stage unknown," not crash. Handled by defaulting the READ side to `"unknown"` when metadata/stage is absent, distinct from the WRITE-side default of `"in_progress"` for new checkpoints that omit the field.
- **Known transport limitation (review finding):** the first-attend surfacing latch is module-level, i.e. once per PROCESS. Under stdio (one process per host session) that equals once per session — the intended semantics. Under the pre-existing HTTP transport (one long-lived process, many callers), the rollup fires at most once for the server's lifetime: no cross-project leak (the process is pinned to one project by `ensureContext`), but reorientation-after-a-gap is effectively a **stdio-only guarantee** until the HTTP transport grows per-session identity. Documented in the attend.ts latch comment; revisit alongside any HTTP session work.
- **Review hardening applied post-build:** rollup queries gained a `desc(id)` secondary sort (same-microsecond `updatedAt` ties were SQL-order-unspecified — a narrow G1 violation); rollup text fields are clamped to 300 chars at the source (the payload rides outside attend's `fitsBudget` accounting, so it must be write-scale-independent); the surfacing latch now ignores mid-turn calls (a mid-turn first call could otherwise burn the one-shot surfacing before the real pre-response arrives).

## 10. Verification

- `src/tests/checkpoints.test.ts` — existing 8 tests, extended (additive) to cover stage/status round-trip; must stay green.
- `src/tests/project-state.test.ts` — new scripted host-simulation suite (separate file, mirrors `host-simulation.test.ts`'s pattern): real work → checkpoint w/ stage+status → module-reset restart → rollup assertions (exact latest checkpoint/stage/status/decisions) → cross-project isolation → empty-project clean case.
- `tsc --noEmit` clean, `pnpm lint` clean.
- `pnpm bench` — all metrics 0.0pp vs baseline, determinism holds (this phase touches no extraction/scoring path).
- Full existing suite counts unchanged except explained additive growth (mcp-tools gains project-state + updated checkpoint-tool cases; checkpoints test count grows additively).

## Changelog
- 2026-07-03 — accepted (pre-authorized by the overnight build mandate; PRD-first, written before code)
- 2026-07-03 — shipped (`c686d000` PRD, `8e58209c` checkpoint stage/status, `0db1da74` rollup + tool + attend surfacing, `63166800` efficacy suite).
  Gates: tsc 0, lint 0; checkpoints 8/8, host-simulation 3/3, rules-relevance 10/10, aliases 17/17,
  projects-isolation 16/16, mcp-tools 53/53 (+1 new `iranti_project_state` tool, additive),
  facts 33/33, it-runs 1/1; new `project-state.test.ts` 4/4. `pnpm bench`: all metrics 0.0pp vs
  baseline across every persona and the overall micro-average, determinism confirmed by the
  harness's own re-run diff.
