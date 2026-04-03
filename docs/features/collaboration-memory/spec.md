# Collaboration Memory

## Overview

This feature makes collaboration first-class inside the Iranti memory layer without turning Iranti into an agent framework, scheduler, or message bus. The core idea is simple:

- agents do not "chat" through Iranti
- agents leave durable collaboration objects in Iranti
- other agents retrieve, update, answer, and resolve those objects

The product goal is that asynchronous multi-agent work should feel like collaboration through shared state rather than isolated runs with occasional recall.

## Product Boundary

### In Scope

- durable collaboration objects such as tasks, asks, decisions, and blockers
- canonical keys, relations, and lifecycle rules for those objects
- host integrations that auto-write collaboration state from obvious assistant actions
- retrieval prioritization so open collaboration work is surfaced before re-inference
- validation that one host can leave collaboration state and another host can pick it up cleanly

### Out Of Scope

- live chat between agents
- agent scheduling or orchestration
- assignment arbitration or queue management
- execution graphs or workflow engines
- control-plane UI beyond thin inspection support

## Canonical Entities

Iranti should standardize the following shared-memory entities for collaboration:

### `task/<task_id>`

Represents an active unit of shared work.

### `ask/<ask_id>`

Represents a durable question from one agent/host to another agent/host or to the shared project context.

### `decision/<decision_id>`

Represents a durable decision with rationale, status, and affected scope.

### `artifact/<artifact_id>`

Optional wrapper for important files, outputs, URLs, or external references when a raw path string is not enough.

## Canonical Keys

### `task/*`

- `status`
- `title`
- `summary`
- `requested_by`
- `current_owner`
- `current_step`
- `next_step`
- `blockers`
- `open_risks`
- `important_artifacts`
- `failed_paths`
- `depends_on`
- `resolution`
- `implementation_status`
- `handoff_ack`

### `ask/*`

- `status`
- `question`
- `context`
- `asked_by`
- `asked_to`
- `related_task`
- `answer`
- `answered_by`
- `resolution`

### `decision/*`

- `status`
- `question`
- `decision`
- `rationale`
- `decided_by`
- `related_task`
- `consequences`

## Canonical Relations

Iranti should support at least these edges:

- `task/* MEMBER_OF project/*`
- `task/* ASSIGNED_TO agent/*`
- `ask/* RELATED_TO task/*`
- `decision/* RELATED_TO task/*`
- `task/* PRODUCED artifact/*`
- `task/* BLOCKED_BY issue/*`
- `task/* DEPENDS_ON task/*`

## Lifecycle

### Task Lifecycle

1. A task is created under a stable `task/<task_id>` entity.
2. The creating host writes `status=open`, `requested_by`, and a compact `summary`.
3. A host or agent may claim the task by writing `current_owner`.
4. During active work, hosts append `current_step`, `next_step`, `blockers`, `important_artifacts`, `failed_paths`, and `implementation_status`.
5. Shared progress should use existing checkpoint records where appropriate, but the task entity remains the canonical collaboration surface.
6. When the task is complete, write `status=resolved` and `resolution`.

### Ask Lifecycle

1. An agent creates `ask/<ask_id>` with `status=open`.
2. The ask records `asked_by`, `asked_to`, `question`, and optional `related_task`.
3. The receiving host should prioritize the ask during retrieval when it is the current owner or target.
4. A response writes `answer`, `answered_by`, and `status=resolved`.
5. The answer remains durable even if the related task later changes owner.

### Decision Lifecycle

1. A decision is created under `decision/<decision_id>`.
2. The write includes the open question, chosen decision, and rationale.
3. Related tasks should link to the decision rather than duplicating rationale into every task row.

## Host Behavior

First-party hosts should translate obvious assistant behavior into collaboration writes.

### Auto-Writes

These patterns should become collaboration facts instead of loose prose:

- `I will take this` -> claim or create `task/*`
- `I am blocked on ...` -> `task/* blockers` or create `ask/*`
- `I need an answer on ...` -> create `ask/*`
- `The answer is ...` -> resolve `ask/*`
- `The next step is ...` -> update `task/* next_step`
- `This is done` -> resolve `task/*`
- `We decided ... because ...` -> write `decision/*`

### Retrieval Priority

`attend()` should prioritize, in order:

1. open `ask/*` entities addressed to the current agent or host
2. open `task/*` entities owned by the current agent
3. open `task/*` entities related to the active project/entity hints
4. recent `decision/*` entities related to the active task or project

This is the critical behavior change that makes collaboration feel first-class instead of accidental.

## Memory-Layer Rules

1. Collaboration objects are shared facts, not private attendant state.
2. Collaboration objects must use stable canonical entities and keys.
3. Collaboration objects should carry semantic metadata like any other durable fact.
4. Collaboration objects may be surfaced through checkpoint and handoff helpers, but they are not reducible to checkpoints.
5. Collaboration objects should remain queryable through the existing SDK, HTTP, and MCP surfaces.
6. Collaboration writes should continue to use Librarian conflict handling; Iranti should not silently invent a winner for competing owners or conflicting resolutions without the normal write path.

## Public Surfaces

This feature should reuse existing surfaces first, then add thin helpers where needed.

### Existing Surfaces To Reuse

- `write()`
- `writeIssue()`
- `checkpoint()`
- `query()`
- `queryAll()`
- `search()`
- `relate()`
- `attend()`

### Thin Helpers To Add

- `createTask(...)`
- `claimTask(...)`
- `updateTask(...)`
- `resolveTask(...)`
- `createAsk(...)`
- `answerAsk(...)`
- `writeDecision(...)`

Equivalent MCP helpers may be added if the SDK/HTTP helpers prove too awkward for first-party hosts.

## Pre-Beta Implementation Plan

This should ship in narrow slices, not as one large abstraction rewrite.

### Slice 1: Canonical Task And Ask Facts

- define canonical task and ask key sets
- add helper functions in the SDK
- add focused MCP wrappers only if first-party hosts need them
- add tests showing one host creates a task/ask and another host retrieves it

### Slice 2: Attend Prioritization

- teach `attend()` to prioritize open asks and owned tasks
- keep explicit entity hints authoritative
- verify ambiguous prompts prefer open collaboration state before generic recap facts

### Slice 3: Host Auto-Write Rules

- Claude hook and MCP host persist claim/block/answer/resolve patterns
- Codex and chat surfaces do the same through shared host helpers
- maintain strict host-contract discipline: no silent writes of arbitrary prose

### Slice 4: Decision Durability

- add `decision/*` canonical shape
- link decisions to tasks and projects
- teach retrieval surfaces to surface recent relevant decisions during handoffs

## Acceptance Criteria

Before beta, this feature is successful if:

1. Claude can create a task and Codex can retrieve it without inheriting Claude's private session.
2. Codex can create an ask and Claude can retrieve and resolve it.
3. `attend()` prioritizes open asks/tasks over generic recap facts for ambiguous prompts like `what should I do next?`
4. Resolved asks/tasks remain queryable in history while current truth stays clean.
5. Collaboration state is visible through existing operator surfaces without bespoke UI.
6. The implementation does not require a scheduler, queue, or host-specific orchestration loop.

## Validation

The pre-beta validation matrix should include:

- a new DB-backed collaboration-memory regression suite
- first-party host tests proving Claude/Codex/chat can hand off through `task/*` and `ask/*`
- retrieval tests proving `attend()` prioritizes open collaboration objects
- API/MCP contract tests for any new helper surfaces
- `npm run build`

## Related

- `docs/features/memory-lifecycle/spec.md`
- `docs/features/cross-tool-handoffs/spec.md`
- `docs/features/issue-facts/spec.md`
- `docs/features/claude-code-mcp/spec.md`
- `docs/features/codex-mcp/spec.md`
