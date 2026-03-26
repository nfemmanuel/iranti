# Memory Lifecycle Implementation Plan

## Goal
Make Iranti lifecycle behavior less dependent on whether Claude, Codex, or another MCP client feels like consulting memory.

## Lifecycle Target
1. Pre-turn retrieval
   - mandatory for recall-class prompts
   - heuristic `attend()` for everything else
2. Post-user-turn capture
   - strict explicit user facts only
3. Pre-action retrieval
   - only when the next action depends on prior memory
4. Post-response capture
   - strict durable summaries only
5. No mid-response or mid-action polling
   - unless the action itself is a memory operation

## Shipped First Slice
- Deterministic mandatory recall detection in `AttendantInstance.attend()`
- Exact key prioritization for recall-class prompts inside `observe()`
- Personal prompt facts stored as direct user memory (`UserPromptAutoRemember`)
- Direct user correction override for personal-memory facts in the Librarian

## Why This Slice Came First
- It fixes the highest-friction trust problem: agents saying `I don't know` or rejecting a direct user correction even when Iranti has the right context.
- It avoids broad autonomous capture.
- It does not require host-specific hooks beyond surfaces Iranti already owns.

## Remaining Work
1. Host integration enforcement
   - Claude: continue using `SessionStart`, `UserPromptSubmit`, and `Stop`
   - Codex: prefer explicit pre-turn `iranti_attend` plus `iranti_remember_response`
2. Pre-action retrieval hooks
   - standardize when an agent should re-read memory before taking a memory-dependent action
3. Project-fact correction policy
   - decide whether direct user project corrections such as `actually, the next step is ...` should get a narrow override path too
4. Better operator diagnostics
   - expose lifecycle phase and enforcement reason more clearly in tool outputs and debug surfaces

## Non-Goals
- Auto-saving every turn
- Polling memory during arbitrary tool execution
- Treating assistant free-form prose as durable truth by default
- Broadly overriding `HumanReview`
