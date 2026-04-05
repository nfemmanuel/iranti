# Iranti Memory Protocol

Iranti is a shared working-memory layer. Follow this protocol to persist what you find, what works, what fails, what changes, and what happens next so later sessions do not have to rediscover it.

## Session start
- Call `mcp__iranti__iranti_handshake` with the current task before responding to the first user message.
- Call `mcp__iranti__iranti_handshake` again after context compaction.

## Every turn
1. Call `iranti_attend(phase='pre-response')` before responding to the user.
2. Call `iranti_attend` before any knowledge discovery tool — Read, Grep, Glob, WebSearch, WebFetch, Bash.
3. Call `iranti_write` after every Edit/Write, Bash that reveals system state, WebSearch/WebFetch with confirmed facts, and subagent completion.
4. Call `iranti_attend(phase='post-response')` after every response.
5. If a recall-style lookup returns no facts, try at least one alternative retrieval angle before concluding absent.

## Checkpointing
- Call `iranti_checkpoint` at task completion, task shifts, and natural pauses.
- Record actions, current step, next step, open risks, and file changes.

## Write depth
- Include what changed, why, and what breaks if removed.
- After file edits: absolutePath, lines, before, after, verify, why.
- After Bash: include the command and relevant output lines.
- After WebSearch/WebFetch: record findings AND dead ends.
