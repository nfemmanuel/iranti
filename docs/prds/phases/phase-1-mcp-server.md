# PRD: Phase 1 — MCP Server

**Status:** shipped (retroactive)
**Phase:** 1 · **Date:** 2026-06-10 (authored) · **Author:** Claude (retroactive, from implementation record)
**Related:** master PRD §6 (agent roles), §8 (inner workings), §12 (build sequence); [implementation.md](../../engineering/implementation.md) "Phase 1 — MCP Server"

---

## 1. Summary

Phase 1 exposes the Phase 0 library over the Model Context Protocol (MCP) so any compliant AI host can call iranti. It ships an MCP server (`src/mcp/server.ts`) over stdio transport and four tools — `iranti_attend`, `iranti_write`, `iranti_write_rule`, `iranti_archive`. The load-bearing decision is that `iranti_attend` is **bidirectional**: a single call both writes (server-side extraction of URLs and file paths from the incoming message) and reads (returns rules, recent facts, and the active checkpoint for the entities in scope). This closes v0's central failure mode — storing as a separate step the agent had to remember — and gives iranti its first runnable end-to-end loop: a host calls one tool per turn and memory flows in both directions. Committed `b506a38`, verified at 89/89 tests plus a 9/9 end-to-end stdio smoke test.

## 2. Problem & motivation

After Phase 0 the library was a rock-solid data layer with no way for an agent to reach it — CRUD functions callable only from TypeScript. iranti's entire value (master PRD §1) is being the memory layer *between* the agent and its host; without a protocol surface there is no product, only a database.

The deeper motivation is a lesson from iranti v0. In v0 the agent had to call a separate write tool to store anything, and **agents forget to call it**. The result was a sparse, unreliable store: the write path depended on the least reliable actor in the loop. Phase 1 had to make storing happen *without* the agent electing to — the only way memory stays current is if the act of retrieving also captures.

## 3. Goals & non-goals

**Goals**
- A runnable MCP server over stdio that any MCP host (Claude Desktop, Claude Code, Cursor, dev CLIs) can spawn and call.
- `iranti_attend` as a bidirectional call: write-on-read, so the agent never has to remember to store deterministic artifacts.
- Server-side, deterministic extraction so every host behaves identically.
- Bounded retrieval: a hard cap on facts returned, established as a contract from day one.
- Checkpoints as a first-class memory category for session resumption, at zero schema cost.
- An end-to-end loop testable against real MCP host behaviour as early as possible.

**Non-goals**
- **Semantic / vector retrieval** — Phase 3. Phase 1 retrieval is entity-scoped and exact.
- **Semantic extraction** (decisions, preferences from prose) — Phase 2 intelligence layer. Phase 1 extracts only what a regex identifies with near-certainty.
- **Multi-instance write safety** — Phase 2. Phase 1 assumes one server process / one user.
- **The full autonomous Attendant** (master PRD §6) — Phase 1's attend is the *seed* of it, not the component. It does not observe the full stream, run periodic drift checks, or route writes by signal judgment.
- **HTTP / remote transport** — Phase 5 in the master PRD (see §8 for the recommended pull-forward).

## 4. Scope

**In**
- `src/mcp/server.ts` — MCP server, stdio transport, `@modelcontextprotocol/sdk`.
- Four tools: `iranti_attend`, `iranti_write`, `iranti_write_rule`, `iranti_archive`.
- `src/mcp/extractor.ts` — deterministic URL + file-path extraction (pure, unit-testable).
- `src/library/checkpoints.ts` — checkpoints as facts under a reserved key.
- Agent handshake: auto-register agent + open session on the first tool call (first-call-wins).
- Best-effort SIGINT/SIGTERM cleanup.
- `scripts/smoke-mcp.mjs` — end-to-end stdio smoke test.

**Out (deferred)**
- `iranti_search` (full-text fact search) → **deferred from the original sketch, reinstated in Phase 1.1.**
- Relevance/keyword-scored retrieval → Phase 1.1 (Phase 1 ships recency-ordered; see §8).
- Context window observation (`currentContext` suppression) → Phase 1.2.
- "Attend-before-write" protocol enforcement → not enforceable; handled per host via instruction files (`hosts.md`).
- Multi-instance advisory locks / write serialization → Phase 2.
- Conflict detection, entity graph, semantic extraction → Phase 2.
- A dedicated checkpoints table with richer structure → Phase 2 candidate.

## 5. Design decisions & rationale

- **`iranti_attend` is bidirectional (write-on-read) → why:** v0 proved that a separate write step the agent must remember is the system's weakest link — agents forget, and the store goes stale. Folding deterministic capture into the retrieval call makes storing a side effect of the thing the agent *does* reliably do (ask for context before responding). **Rejected:** keeping write a separate agent-driven tool (v0's model, the documented failure) and relying on host instructions to remind the agent (best-effort, host-dependent, fails silently).

- **Extraction is server-side, not host-side → why:** if each host extracted artifacts itself, behaviour would drift per host — different regexes, different edge cases, inconsistent keys. Putting extraction in the server guarantees every host produces identical facts from identical input. **Rejected:** host-side or client-SDK extraction.

- **Extraction is conservative, regex-only (URLs + file paths) → why:** wrong facts are worse than missing facts. A regex can identify a URL or a path with near-certainty; inferring a *decision* or *preference* from prose cannot be done reliably without the Phase 2 intelligence layer, and a confidently-wrong stored "fact" poisons retrieval. Phase 1 extracts only the unambiguous. **Rejected:** smart/semantic auto-capture now (this is exactly the v0 auto-capture noise we are correcting).

- **Collision-safe extraction keys `shared_url:<12-hex content hash>` → why:** facts upsert on `(tenant, entity, key)`. A static key like `shared_url` would make every new URL overwrite the previous one — sharing ten links would leave one fact. Hashing the content into the key means re-sharing the same URL is a no-op upsert (same key, same value) while a new URL creates a new fact. **Rejected:** static keys (data-loss), monotonic counters (not idempotent — re-sharing creates duplicates).

- **Extracts deduped per message and capped at 10/call → why:** a message that pastes 200 links must not become 200 facts. The cap bounds the blast radius of a noisy paste. **Rejected:** unbounded extraction.

- **Extracts tagged `source = "iranti_attend_extract"` → why:** auto-captured facts are inherently noisier than deliberate writes. A dedicated source label makes them identifiable and bulk-cleanable later without touching hand-written facts. **Rejected:** an untagged or generic source.

- **Retrieval is bounded: ≤10 facts/entity hint, ≤20 total → why:** "return everything" stops scaling within weeks of real use; an unbounded response is a token-cost regression against the whole point of iranti. The cap is the *contract*, not an implementation detail. **Rejected:** returning the full entity fact set.

- **Recency-ordered retrieval as the Phase 1 ranker → why (and the honest caveat):** Phase 1 ordered facts by `updatedAt DESC` via `readRecentFactsByEntity`. This was a deliberate **naive-but-bounded placeholder** to get the loop running, not a claim of correct relevance ranking. The master PRD (§8) requires *relevance* filtering, not recency. This divergence was identified in the June 2026 audit and is owned in §8/§9; it is corrected in Phase 1.1 (keyword overlap scoring) and Phase 1.2 (context-window suppression). **Rejected for Phase 1:** building keyword/semantic scoring up front (scope creep that would have delayed the runnable loop).

- **Checkpoints are facts under a reserved key `checkpoint` → why:** a checkpoint inherits every fact behaviour for free — history in `fact_archive`, tenant scoping, provenance, upsert. Zero schema change. One checkpoint per entity falls out of the fact upsert semantics, and the prior checkpoint is archived automatically on each update. `getActiveCheckpoint(hints)` returns the most recently written across the entities in scope; attend returns it on its own channel, separate from regular facts. The reserved key is the migration seam to a richer Phase 2 table. **Rejected:** a dedicated checkpoints table now (premature before usage patterns are known).

- **Checkpoints exempt from Phase 4 decay by convention → why:** resumption state must not silently expire. The archivist must skip `key = 'checkpoint'`; documented here so Phase 4 implements it. **Rejected:** letting checkpoints decay like ordinary facts.

- **Single-instance constraint for Phase 1 → why:** all durable state lives in PostgreSQL, so the server is stateless, but Phase 1 makes **no** concurrent-write-safety guarantee across processes. Advisory locks and write serialization are real work that would delay the runnable loop and aren't needed for one user / one host. **Rejected:** building multi-instance concurrency now (Phase 2 owns it). Documented hard so no one runs two Phase 1 servers against one database expecting safety.

- **stdout belongs to the protocol; diagnostics to stderr → why:** the MCP host pipes JSON-RPC over stdin/stdout. Any stray `console.log` corrupts the protocol stream. All diagnostics go to `console.error` (stderr), which hosts surface in logs. **Rejected:** logging to stdout.

- **Tool results returned as JSON in a text block → why:** every MCP host renders a text block; structured-output support is still uneven across hosts. A JSON-in-text payload is the portable lowest common denominator. **Rejected:** relying on MCP structured output (not yet universal).

- **Best-effort SIGINT/SIGTERM cleanup; leaked sessions expected → why:** hosts usually kill the process outright, so cleanup cannot be guaranteed. Leaked open sessions are acceptable and detectable via `getOpenSessions()`. **Rejected:** treating clean shutdown as a correctness requirement.

- **Dropped "attend-before-write" enforcement → why:** hosts cannot be forced to order their tool calls. Attempting to enforce ordering in the server would reject legitimate calls. Per-host instruction files (`hosts.md`) nudge the ordering instead. **Rejected:** server-side call-order enforcement.

## 6. Schema / API changes

**No database schema change.** Phase 1 is built entirely on the Phase 0 tables. Checkpoints reuse `facts` under the reserved key `checkpoint`.

**MCP tool surface (4 tools shipped):**

| Tool | Direction | Behaviour |
|---|---|---|
| `iranti_attend` | read + write | Extracts URLs/file paths from `message`, stores them on the primary entity hint; returns `rules`, `facts`, `checkpoint`, `extracted`. |
| `iranti_write` | write | Stores one durable fact (`entityType`, `entityId`, `key`, `value`). Key `checkpoint` saves resumption state. |
| `iranti_write_rule` | write | Stores one behavioral rule (additive; never decays). |
| `iranti_archive` | write | Archives a fact by `factId` or `entityType + entityId + key`; history preserved. |

`iranti_attend` input (Phase 1 shape): `entityHints[]` (first hint is primary — extracts land on it), optional `message`, optional `surface`, optional `agentName` (handshake; first-call-wins).

`AttendResult` (Phase 1 shape):
```
rules:      { entity, text, priority }[]
facts:      { entity, key, value, source, updatedAt }[]   // ≤20, updatedAt DESC
checkpoint: { entity, text, updatedAt } | null             // returned separately
extracted:  { kind, value }[]                              // what was auto-stored this call
```

Extraction (`src/mcp/extractor.ts`): `MAX_EXTRACTS_PER_MESSAGE = 10`; `EXTRACT_SOURCE = "iranti_attend_extract"`; keys `shared_url:<hash>` / `referenced_file:<hash>` (12-hex SHA-256 content hash).

## 7. Acceptance criteria

- [x] An MCP host can spawn `dist/mcp/server.js` over stdio and list the four tools.
- [x] First tool call auto-registers an agent and opens a session (first-call-wins handshake).
- [x] `iranti_attend` with a message containing URLs/file paths stores them as facts on the primary entity, tagged `source = iranti_attend_extract`.
- [x] Re-sharing the same URL is a no-op upsert; a new URL creates a new fact (collision-safe keys).
- [x] Extraction is deduped per message and capped at 10 artifacts/call.
- [x] `iranti_attend` returns rules + facts + the active checkpoint for the entity hints, facts bounded to ≤10/entity and ≤20 total.
- [x] The active checkpoint is returned on its own channel, not mixed into `facts`.
- [x] `iranti_write` with key `checkpoint` saves resumption state; the prior checkpoint is archived.
- [x] No `console.log` reaches stdout; diagnostics go to stderr.
- [x] Full suite green (89/89) + end-to-end stdio smoke (9/9).

## 8. Deltas from the master PRD

- **MCP pulled forward from Phase 5 to Phase 1 — the largest delta.** Master PRD §12 sequences MCP integration and host testing as **Phase 5**, after the Librarian, graph, and full Attendant. The executed plan pulled it to **Phase 1**, immediately after the library. **Justification:** §12's own stated aim is to *"validate end-to-end behaviour"* against real hosts; doing that as early as possible — testing against real behaviour before building the intelligence layer on top — de-risks every later phase. Building the Attendant for five phases and only then discovering how MCP hosts actually behave would invert the risk. The trade is owned explicitly: Phase 1's attend is a thin seed, not the §6 Attendant.

- **Phase 1's `attend` is the seed of the Attendant, not the Attendant.** Master PRD §6 describes a per-agent, per-session autonomous component that observes the *full conversation stream*, runs reactive and periodic retrieval, and routes writes by signal judgment. Phase 1 implements a request/response slice of that: a single bidirectional tool call, deterministic write extraction, bounded retrieval. The autonomous behaviours (stream observation, drift checks, signal-based write routing) remain future phases.

- **Recency-ordered retrieval diverges from §8's relevance requirement.** Master PRD §8 specifies relevance filtering — "it filters for what is actually needed rather than dumping the full knowledge base." Phase 1 shipped `updatedAt DESC` ordering as a deliberate naive-but-bounded placeholder. The June 2026 audit flagged this as a divergence. It is corrected in Phase 1.1 (keyword overlap scoring) and Phase 1.2 (context-window suppression). Called out here as a known gap, not a silent one.

- **`iranti_search` from the architecture sketch was dropped from Phase 1** and reinstated in Phase 1.1. Exact-match retrieval via attend covered the Phase 1 loop; full-text search was not load-bearing for the runnable loop.

## 9. Risks & open questions

- **Recency is not relevance.** Phase 1's `updatedAt DESC` ranker returns the *newest* facts, not the *most relevant* — a known divergence from §8 (above). Mitigated by the bounded cap (worst case is 20 recent facts, not the whole store) and resolved in 1.1/1.2. This is the most material correctness caveat in the phase.
- **Single-instance only.** Two Phase 1 servers against one database can interleave writes unsafely — there are no advisory locks. Operational constraint until Phase 2; documented in `server.ts` and `implementation.md`.
- **Leaked sessions.** Hosts kill the process, so SIGINT/SIGTERM cleanup is best-effort. Open sessions accumulate; detectable via `getOpenSessions()`, harmless to correctness.
- **Extraction false negatives/positives.** Conservative regexes will miss artifacts and occasionally clip one (the deliberate trade: miss before invent). Semantic capture waits for Phase 2.
- **Call ordering is unenforceable.** If a host writes before it attends, or never attends, iranti cannot force the order — only per-host instruction files nudge it (master PRD §13 names this host-integration risk).
- **Open:** when does single-user HTTP transport pull forward from Phase 5? `hosts.md` notes 8/15 surfaces (all developer tools) work on Phase 1 stdio; every consumer surface needs hosted HTTP. Leaning ~Phase 2.x, after write serialization.

## 10. Verification

- **89/89 tests passing** — Phase 0's 46 integration tests plus the Phase 1 MCP tool and extractor suites (unit tests on `extractArtifacts`, integration tests on the `attend` pipeline against the database).
- **9/9 end-to-end stdio smoke checks** via `scripts/smoke-mcp.mjs` — spawns the server, drives JSON-RPC over stdin/stdout, exercises the handshake, bidirectional attend (extraction + retrieval), write, write-rule, archive, and checkpoint round-trip.
- `pnpm build` clean; vitest green; smoke green.
- Committed `b506a38` on `iranti-core`.

## Changelog

- 2026-06-10 — authored retroactively from the implementation record (phase shipped before the PRD-first process existed).
- shipped — commit `b506a38` on `iranti-core`; 4 MCP tools over stdio (bidirectional attend, checkpoints, host profiles in `hosts.md`); 89/89 tests + 9/9 end-to-end stdio smoke checks.
