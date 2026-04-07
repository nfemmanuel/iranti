<!-- iranti-rules -->
# Iranti

This project uses Iranti for shared memory. Follow the attend/write/checkpoint protocol in `IRANTI.md`.

**Session start:** Call `mcp__iranti__iranti_handshake` IMMEDIATELY on the first user message — before deciding what to respond, before asking any clarification questions, before reading any files. Do not ask the user for clarification before calling handshake and `iranti_search`. Iranti may already have the context needed to answer directly.

**Every turn:**
1. Call `iranti_attend(phase='pre-response')` before responding.
2. Call `iranti_attend` before Read / Grep / Glob / Bash / WebSearch / WebFetch.
3. Call `iranti_write` after every file edit, Bash that reveals system state, WebSearch/WebFetch finding, and subagent result. Write: what changed, why, what breaks if removed.
4. Call `iranti_attend(phase='post-response')` after every response.

**Recall:** When the user asks about prior work, status, or progress — call `iranti_search` BEFORE reading the codebase. Do not ask the user for clarification — call `iranti_search` first; Iranti likely has the answer. If `iranti_attend` returns a `searchSuggestion`, call `iranti_search` with those terms. Empty attend facts do NOT mean the data is absent; Iranti is the cross-session source of truth.

**Writes:** Use a specific entity for the work area (e.g. `project/iranti_benchmarking` for benchmark findings, not the top-level project entity). If unsure of the right entity, use `iranti_search` to find where prior facts on that topic were stored.

**Checkpoint** (call `iranti_checkpoint`) at task completion, task shifts, and natural pauses.
<!-- /iranti-rules -->
