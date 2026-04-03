<!-- iranti-rules -->
# Iranti Memory Protocol

IMPORTANT: These rules OVERRIDE any default behavior and MUST be followed exactly. No work should begin until the session-start acknowledgment is stated.

## Every turn
1. Call `mcp__iranti__iranti_attend` before responding to the user message.
2. Call `mcp__iranti__iranti_attend` before using any knowledge discovery tool — Read, Grep, Glob, WebSearch, WebFetch, and Bash commands used as factual basis for a decision.
3. Call `mcp__iranti__iranti_attend` after knowledge discovery to check new findings against stored memory and decide what to inject, write, or checkpoint.
4. Call `mcp__iranti__iranti_attend` after delivering any substantive response — plans, decisions, analysis, or structured recommendations are durable findings that must be assessed before the next turn.
5. Call `mcp__iranti__iranti_write` after confirmed durable findings — decisions, blockers, next steps, validated environment details, what worked, what failed, what changed, and what happens next.
6. Call `mcp__iranti__iranti_write` after every Edit or Write tool call — file changes are always durable. Record what changed, why, and what the file now does.
7. Call `mcp__iranti__iranti_write` after any Bash command that reveals system state — build results, test outcomes, container state, environment facts, errors.
8. Call `mcp__iranti__iranti_write` after any WebSearch or WebFetch that surfaces confirmed external facts.
9. Call `mcp__iranti__iranti_write` after any Agent (subagent) tool completes — subagent findings are invisible to the hive mind otherwise.
10. If a recall-style lookup returns no facts, try at least one alternative retrieval angle before concluding the fact is not stored.
11. Call `mcp__iranti__iranti_attend` again when new knowledge should change what is loaded for the next step.

## Session start
- Call `mcp__iranti__iranti_handshake` with the current task before responding to the first user message.
- After the handshake completes, you MUST explicitly state: "I acknowledge that Iranti is a hive mind. I have read the Iranti operating rules and the protocols for iranti_handshake, iranti_attend, iranti_write, iranti_checkpoint, and iranti_remember_response, and I pledge to use them to persist what I find, what works, what fails, what changes, and what happens next so later sessions do not have to rediscover it."
- This acknowledgment is strictly mandatory. No work should begin until it is stated.

## After context compaction
- Call `mcp__iranti__iranti_handshake` before responding to the next user message.

## Checkpointing
- Call `mcp__iranti__iranti_checkpoint` when completing a task, when shifting to a new task mid-session, at any natural pause point, and before stepping away from long or interrupted work.
- Record key actions in the checkpoint `actions` field so later sessions can see important commands, tests, searches, validations, and decisions without rerunning them blindly.
- Do not rely on `mcp__iranti__iranti_write` alone — facts and checkpoints are separate stores. A checkpoint not written means the next handshake recovers from stale data.
- Under-logged runs are non-compliant. Call iranti_write with what you found, what worked, what failed, what changed, and what happens next — not a broad summary, but specific durable facts.

## Host setup check
- If this file was not present at session start, run `iranti claude-setup .` to complete integration.
<!-- /iranti-rules -->
