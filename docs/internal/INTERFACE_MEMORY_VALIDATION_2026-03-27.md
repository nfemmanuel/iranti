# Interface Memory Validation - 2026-03-27

## Scope

This validation pass checks live Iranti memory behavior across:

- multiple interfaces
- multiple repos bound to the same Iranti instance
- personal-memory routing via `IRANTI_PERSONAL_MEMORY_ENTITY`

This file is intentionally a validation artifact, not a product contract.

## Test Fact

Fresh personal-memory fact used for the pass:

- entity: `user/main`
- key: `favorite_painter`
- value: `hilma af klint`

Reason for choice:

- new key with low contamination risk
- personal preference should resolve cross-repo
- easy to test with natural-language recall

## Repos Observed

- `C:\Users\NF\Documents\Projects\iranti`
- `C:\Users\NF\Documents\Projects\iranti-control-plane`
- `C:\Users\NF\Documents\Projects\iranti-benchmarking`

## Expected Behavior

For this test, success means:

1. the fact is stored on `user/main`
2. a client in another repo can still recall it
3. the answer is available without needing a project-scoped fallback

## Results

| Interface | Repo | Result | Notes |
|---|---|---|---|
| Claude Code VS Code | `iranti-control-plane` | PASS | Answered `Hilma af Klint.` directly |
| Claude Code CLI | `iranti-benchmarking` | PASS | Answered `Hilma af Klint.` directly |
| Claude Code CLI | `iranti` | PASS | Answered `Hilma af Klint.` directly |
| Codex CLI | `iranti` | PASS | Called `iranti.iranti_attend(...)` and answered `Hilma af Klint.` |
| Codex VS Code | `iranti-benchmarking` | FAIL / INTERMITTENT | One session answered `I don't know yet...`; a fresh explicit probe then reported that `iranti_query` was not exposed in the current MCP session |

## Supporting Evidence

### Stored Fact

Direct query in `iranti` repo showed:

- entity: `user/main`
- key: `favorite_painter`
- resolved entity: `user/main`

This confirms the fact exists in user-scoped memory rather than project-scoped memory.

### Cross-Repo Recall

Observed successful recall from:

- `iranti-control-plane`
- `iranti-benchmarking`
- `iranti`

This confirms personal-memory routing is working across repos when the client is actually connected to Iranti.

### Codex CLI Behavior

Codex CLI in `iranti` called:

- `iranti.iranti_attend(...)`

It then returned the correct answer:

- `Your favorite painter is Hilma af Klint.`

This is the strongest signal in the pass because it validates:

- live MCP connection
- recall classification
- memory retrieval
- answer generation from retrieved memory

## Current Diagnosis

The memory system itself is behaving correctly for this scenario.

What is working:

- personal-memory storage
- personal-memory cross-repo recall
- Claude Code CLI
- Claude Code VS Code
- Codex CLI

What is not yet reliable:

- Codex VS Code session wiring to Iranti MCP

The remaining problem is not the KB or the retrieval path. It is the consistency of MCP availability inside Codex VS Code sessions.

### Fresh Explicit Codex VS Code Probe

Prompt used in a fresh Codex VS Code session:

- `Use the MCP tool iranti_query for entity user/main and key favorite_painter. Do not inspect the repository or run shell commands.`

Observed result:

- Codex VS Code said it could not run `iranti_query`
- it reported that no MCP resources or templates were available in the current session
- it did not inspect the repo or run shell commands

Interpretation:

- this is a session MCP exposure problem
- not a memory retrieval correctness problem
- not a `user/main` routing problem

## Release Gate Read

For this validation slice:

- core memory behavior: PASS
- cross-repo personal memory: PASS
- Codex VS Code integration: NOT YET CLEAN

Recommended release posture:

1. do not use Codex VS Code as a release blocker for core memory correctness
2. do track Codex VS Code as a separate integration issue
3. before shipping any client-behavior claim that includes Codex VS Code, re-run an explicit probe in a fresh session:
   - `Use the MCP tool iranti_query for entity user/main and key favorite_painter.`
4. treat missing MCP exposure in Codex VS Code as a separate integration bug from Iranti memory correctness

## Next Checks

To close the remaining gap, run in a fresh Codex VS Code session:

1. explicit MCP query for `user/main / favorite_painter`
2. natural-language recall for `what is my favorite painter?`
3. confirm the session is using the real `iranti` MCP server rather than an empty or stale MCP surface
