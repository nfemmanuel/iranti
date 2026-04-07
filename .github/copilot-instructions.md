<!-- iranti-rules -->
# Iranti

This project uses Iranti for shared memory. Follow the attend/write/checkpoint protocol in `IRANTI.md`.

**Session start:** Call `mcp__iranti__iranti_handshake` before responding to the first user message.

**Every turn:**
1. Call `iranti_attend(phase='pre-response')` before responding.
2. Call `iranti_attend` before Read / Grep / Glob / Bash / WebSearch / WebFetch.
3. Call `iranti_write` after every file edit, Bash that reveals system state, WebSearch/WebFetch finding, and subagent result. Write: what changed, why, what breaks if removed.
4. Call `iranti_attend(phase='post-response')` after every response.

**Checkpoint** (call `iranti_checkpoint`) at task completion, task shifts, and natural pauses.
<!-- /iranti-rules -->
