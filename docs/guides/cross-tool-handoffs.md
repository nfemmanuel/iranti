# Cross-Tool Handoffs

Use this guide when Claude Code and Codex need to work on the same task through one Iranti instance.

The critical rule is simple:

- session recovery is **agent-scoped**
- handoff is **shared-memory-scoped**

Claude should checkpoint Claude's own session. Codex should not try to resume Claude's session id. Instead, both tools should collaborate through shared `task/...` and `project/...` facts.

## Prerequisites

- `npm install -g iranti`
- a running Iranti instance, for example `iranti run --instance local`
- both projects or tools bound to the same instance
- stable agent ids for both tools

Example bindings:

```bash
iranti project init . --instance local --agent-id claude_code_main
iranti project init . --instance local --agent-id codex_code_main
```

Recommended stable ids:

- Claude Code: `claude_code_main`
- Codex: `codex_code_main`

## 1. Pick one shared task entity

Use one canonical task entity for the whole handoff:

```text
task/runtime_verification_pass
```

Do not invent a new task entity name in each tool. If the names drift, retrieval quality drops and the handoff becomes ambiguous.

Useful shared keys:

- `status`
- `current_owner`
- `next_step`
- `blockers`
- `artifacts`
- `decision`
- `implementation_status`

## 2. Sender writes the durable handoff

Before Claude hands work to Codex, write explicit shared facts:

```text
task/runtime_verification_pass / status = ready_for_codex
task/runtime_verification_pass / current_owner = codex_code_main
task/runtime_verification_pass / next_step = implement the runtime verification pass
task/runtime_verification_pass / blockers = preserve compatibility docs
task/runtime_verification_pass / artifacts = docs/guides/codex.md, docs/guides/claude-code.md
```

Use `iranti_write` or the SDK directly. Do not rely on a session checkpoint alone for cross-tool continuity.

## 3. Sender checkpoints its own session

Claude should still checkpoint Claude's own session before handing off:

```ts
await iranti.checkpoint({
  agentId: 'claude_code_main',
  task: 'Prepare Codex handoff for runtime verification pass.',
  recentMessages: [
    'Writing shared handoff facts for Codex.',
    'Checkpointing before handoff.'
  ],
  checkpoint: {
    currentStep: 'captured shared task status and next step',
    nextStep: 'hand task to Codex via shared memory',
    openRisks: ['Receiver must preserve compatibility docs'],
    recentOutputs: ['Persisted handoff facts to task/runtime_verification_pass'],
    entityTargets: ['task/runtime_verification_pass', 'project/iranti'],
    notes: 'Codex should read shared task facts instead of trying to resume this Claude session.'
  }
});
```

This checkpoint helps Claude recover Claude's own work later. It is not the cross-tool handoff itself.

## 4. Receiver starts its own session

Codex begins its own handshake:

```ts
await iranti.handshake({
  agentId: 'codex_code_main',
  task: 'Continue the shared runtime verification pass.',
  recentMessages: [
    'Resume work for task/runtime_verification_pass.',
    'Read the shared handoff and continue implementation.'
  ]
});
```

That handshake initializes Codex's own agent-scoped session state. It does not automatically import Claude's private checkpoint or the shared `task/...` facts.

Then retrieve the shared task explicitly:

- `query()` when the key is known
- `attend()` with `entityHints` when the task is broader or contextual

Example:

```ts
const attend = await iranti.attend({
  agentId: 'codex_code_main',
  latestMessage: 'Continue work for task/runtime_verification_pass. What should I do next?',
  currentContext: 'We are continuing a shared task handoff between Claude Code and Codex.',
  entityHints: ['task/runtime_verification_pass', 'project/iranti'],
  maxFacts: 5
});
```

## 5. Receiver writes acknowledgment and progress

Codex should write back to the same shared task entity:

```text
task/runtime_verification_pass / implementation_status = started_by_codex
task/runtime_verification_pass / current_owner = codex_code_main
```

That makes pickup visible to Claude and to any later operator inspection.

## 6. Operators inspect sender and receiver separately

Session inspection is still agent-scoped:

- `inspectSession({ agentId: 'claude_code_main' })` shows Claude's private checkpoint
- `inspectSession({ agentId: 'codex_code_main' })` should stay empty until Codex checkpoints its own work
- `listSessions({ agentId: 'claude_code_main', operatorState: 'active' })` can inventory only Claude's checkpoint state

If you want a recovery recommendation instead of raw checkpoint visibility, pass the same candidate task context you would use for a real handshake:

```ts
const claudeInspection = await iranti.inspectSession({
  agentId: 'claude_code_main',
  task: 'Prepare Codex handoff for runtime verification pass.',
  recentMessages: ['Review the sender-local handoff checkpoint.'],
});
```

That will not let Codex resume Claude's session. It only lets an operator or sender-side tool evaluate Claude's own checkpoint against a candidate return task.

## 7. Sender reconvenes from shared memory later

When Claude comes back, Claude should query or attend against the same shared task entity:

```ts
const followUp = await iranti.attend({
  agentId: 'claude_code_main',
  latestMessage: 'Check whether Codex picked up task/runtime_verification_pass.',
  currentContext: 'Claude is reviewing the shared handoff state.',
  entityHints: ['task/runtime_verification_pass'],
  maxFacts: 5
});
```

That is the supported way to see Codex's progress. Claude does not need Codex's private session state.

## Recommended conventions

- one shared task entity per collaborative workstream
- stable agent ids per tool
- explicit ownership/status facts
- explicit `entityHints` on receiver `attend()` calls
- checkpoint before handoff
- write acknowledgment after pickup

## Verification

Run the smoke test:

```bash
npm run test:cross-tool-handoff
```

That test proves:

- Claude can write a shared handoff
- Claude can checkpoint its own session
- operator inspection can see Claude's checkpoint without leaking it into Codex
- Codex can read the shared task through query and attend
- Codex can write follow-up progress
- Claude can recover the follow-up through shared memory

## Related

- `docs/guides/claude-code.md`
- `docs/guides/codex.md`
- `docs/features/cross-tool-handoffs/spec.md`
- `tests/cross-tool/run_cross_tool_handoff_tests.ts`
