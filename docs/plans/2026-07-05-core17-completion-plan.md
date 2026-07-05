# CORE-17 Completion Plan — make iranti's OWN retrieval-first recall real and MEASURABLE

**Date:** 2026-07-05
**Author:** system-architect / technical LEAD (with TPM + Principal Engineer charters binding)
**Branch:** `feat/core-17-retrieval-first`
**Scope of this document:** the pre-benchmark engineering (S1–S4) plus the in-iranti measurement cell (S5) that is the acceptance gate. This plan is the ONLY file authored here — no source/test/config was modified to write it.
**Governing PRD:** `docs/prds/phases/core-17-retrieval-first-recall.md` (§7 acceptance, §9 decisions).
**Reference implementation to mirror (fully wired, proven):** CORE-16 semantic tier — `src/library/facts.ts` (`fillRemainingWithSemantic` 830, `semanticSlotFill` 770, `fetchSemanticCandidates` 733, write-hook fire at 508–516), `src/embed/write-hook.ts` (`embedFactOnWrite`), `src/mcp/tools/attend.ts` (write side 484–519, read side 558–570, output assembly 941–971).

---

## 0. Honesty preamble (the rule this whole plan enforces)

The status ladder is `DESIGNED → BUILT → WIRED → TESTED → MEASURED`. No rung is claimed before it is reached. Two numbers must never be conflated:

- **79.2%** is the **bench-only concept-test adapter** `bench/competitive/adapters/chunk-rag.ts` (an in-memory `Map`-based RAG that never touches iranti's store). Provenance: `bench/competitive/results-chunkrag/summary.json` — `system: "iranti-next:chunk-rag"`, `mean 0.7917`, `runs 1`, `variance 0`, reader+judge both `claude-sonnet-5`, n=24 stratified LongMemEval-S subsample, track H. **This is NOT iranti's number.**
- **12.5% (heuristic) / ~18–20% (frontier)** is **iranti's actual current recall** through `iranti_attend`'s lexical/keyword path with `IRANTI_EMBEDDER: "off"`. Verified from the per-question ledgers: `bench/competitive/results-lmeval/cell__iranti-next_heuristic__longmemeval-s__H.json` = mean 0.1250 (n=24); `...__G.json` = 0.1250 (n=24); `cell__iranti-next_frontier__longmemeval-s__G.json` = 0.2000 (n=15, generous track). **This is iranti's number today.**

CORE-17 is "done" only when iranti's OWN measured retrieval-first recall exists under stated conditions. Until S5 produces it, the only recall number iranti may quote about itself is the 12.5%/18–20% above.

---

## 1. Honest current baseline — status rung of each piece, grounded in code

| Piece | Rung TODAY | Evidence (`path:line`) |
|---|---|---|
| `chunks` table (schema) | **BUILT** | `src/db/schema.ts:274` (`export const chunks = pgTable(`); migration `drizzle/0015_condemned_miracleman.sql:1-20` (vector(768) + HNSW on Postgres); PGlite override `src/db/connection.ts:215-234` (substitutes `text` for the vector column, drops HNSW, keeps table/FKs/btree verbatim). |
| `writeChunk` / `embedChunkOnWrite` / `searchChunksSemantic` | **BUILT + TESTED-in-isolation** | `src/library/chunks.ts:62` (writeChunk), `:119` (embedChunkOnWrite), `:174` (searchChunksSemantic). Own floor `CHUNK_SIMILARITY_FLOOR = 0.6` (`:32`), own cap `SEMANTIC_CHUNK_CAP = 500` (`:42`), project-scoped candidate fetch (`:147`). Correctly reuses CORE-16 machinery (`buildEmbedRegime`/`regimeMatches` `:24`, `embeddingAssignmentSql`/`parseStoredVector` `:25`, `cosineSimilarity` `:23`). |
| Unit tests for the chunk layer | **TESTED-in-isolation (4/4, MockEmbedder)** | `src/tests/chunks.test.ts` — 4 `it(...)` cases: meaning-closest retrieval (`:67`), abstention on unrelated query (`:82`), no-op when embedder off (`:101`), cross-project isolation (`:118`). Uses `IRANTI_EMBEDDER="mock"` (`:29`), temp PGlite — deterministic, no live Ollama. |
| **Chunk write path in the product** | **ABSENT (not WIRED)** | `grep -i chunk src/mcp/tools/attend.ts` → **0 matches**. `attend()` (`attend.ts:461`) writes facts (`:489 writeFact`) and aliases (`:510 learnAlias`) but never `writeChunk`/`embedChunkOnWrite`. |
| **Chunk read path / query router** | **ABSENT (not WIRED)** | No `searchChunksSemantic` call anywhere outside `chunks.ts`+`chunks.test.ts` (`grep searchChunksSemantic src` → those 2 files only). No STRUCTURED-vs-OPEN router in `attend.ts`. Read side (`:558-570`) only calls `readRelevantFactsWithMatch`. |
| **`AttendResult.chunks[]` + abstention signal** | **ABSENT (not DESIGNED in code)** | `AttendResult` interface (`attend.ts:308-376`) has `facts`, `peripheral`, `checkpoint`, `extracted`, `alreadyPresent`, `corrections`, `media`, `nextDue`, `projectState` — **no `chunks` field, no abstention field**. Output assembly (`:941-971`) emits none. |
| **Embedder auto-ON-when-reachable** (PRD §9 decision) | **DECIDED but UNCODED** | `getEmbedderMode()` (`src/embed/index.ts:63-68`) returns `off` unless `IRANTI_EMBEDDER` is explicitly `ollama`/`mock`. No reachability probe exists. `.env.example:13` still ships `IRANTI_EMBEDDER=off`. So even after S1–S3, the recall tier stays dark on every default install. |
| **In-iranti recall measurement (iranti's OWN number)** | **NOT MEASURED — and not yet measurable** | The one adapter that exercises iranti (`bench/competitive/adapters/iranti-next.ts`) hardcodes `IRANTI_EMBEDDER: "off"` (`:80`) and reads only `parsed.facts` (`:177`), never chunks. So the harness *cannot* see the recall layer even after S1–S3 land. S5 is required to make it measurable. |

**One-sentence baseline:** the chunk recall layer is a well-built, unit-tested **island** (`chunks.ts` + table + migration + 4 green isolation tests) with **zero product callers**; `attend` neither writes nor reads chunks, the embedder defaults off, and the bench adapter is blind to chunks — so iranti's own retrieval-first recall is **unmeasured and structurally unmeasurable** until this plan's stages land. The audit's "~15% done" is confirmed in code.

---

## 2. Ordered stages (each: goal · files · pattern-to-mirror · acceptance criterion + target rung · risks/mitigation · roles)

Ordering is dependency-forced: **S1 (write) → S2 (read/router) → S3 (abstention) → S4 (auto-ON) → S5 (measure)**. You cannot retrieve a chunk you never wrote (S1 before S2); abstention is a property of the read result (S2 before S3); the bench must run with the tier actually active (S4 before S5); and S5 is the acceptance gate that consumes all four.

> **Cross-cutting invariant, asserted in every stage's acceptance:** the **embedder-off path must stay byte-identical to today.** Every new call site guards on `isEmbedderActive()` first (the whole cost on the default path), exactly as `embedFactOnWrite` (`write-hook.ts:19`) and `fillRemainingWithSemantic` (`facts.ts:840`) do. The regression proof is `pnpm bench` with the embedder off = 0.0pp drift (PRD §7).

---

### S1 — Write path: `attend` stores + embeds a chunk (fire-and-forget)

**Goal.** On a real write turn, persist the raw conversation message as a chunk and embed it in the background, scoped to the current project — so the recall pool actually fills. This is the precondition for everything downstream.

**Files to touch.**
- `src/mcp/tools/attend.ts` — in the WRITE side (after the artifact/alias block, ~`:519`, still gated on `!isMidTurn && input.message`), add a `trackBackground(writeChunk(...).then(id => embedChunkOnWrite(id, content)))` on `input.message`, scoped to `currentProject` (`:472`), passing `ctx.session.id` / `ctx.agent.id` / `input.surface` into `WriteChunkInput`.
- Import `writeChunk`, `embedChunkOnWrite` from `../../library/chunks.js`.

**Pattern to mirror (cite).** `src/library/facts.ts:508-516` — the `embedFactOnWrite` fire-and-forget: `trackBackground( embedFactOnWrite(...).catch(err => console.error(...)) )`. Mirror the `trackBackground` + `.catch` discipline (RULE-2) exactly. `chunks.ts:58-61`'s own header already specifies "fire-and-forget via trackBackground on the live write path; awaited directly in tests/bench for determinism." Access `trackBackground` the same way `attend.ts` already does for its post-attend chain (`:930`).

**Written measurable acceptance criterion.** A new integration test in `src/tests/` (mirror `chunks.test.ts` + `semantic-retrieval.test.ts` harness: temp PGlite, `IRANTI_EMBEDDER="mock"`, `IRANTI_EXTRACT_SYNC="1"` so background settles): call `attend({ message, entityHints:[project], phase:"post-response" })`; then assert a row exists in `chunks` for that project **and** its `embedding` column is non-null (embedded) **and** its `metadata.embedRegime` is set. Second assertion: with `IRANTI_EMBEDDER="off"`, the same `attend` call writes **zero** chunks (or writes the row but does not embed — pick per the guard's placement; the test pins whichever is implemented) and `pnpm bench` off-path is unchanged. **Target rung: TESTED.**

**Risks + mitigations.**
- *Risk:* double-write / write on read (mid-turn queries also carry `message`). *Mitigation:* gate strictly on `!isMidTurn` (the same gate artifact extraction uses, `:484`) so a query never seeds a chunk.
- *Risk:* background chunk embed races teardown in bench/tests. *Mitigation:* it is `trackBackground`'d → settled by `closeDb`'s `settleBackground(5000)` (`connection.ts:134`); tests use `IRANTI_EXTRACT_SYNC` / await, as `chunks.test.ts:62` already documents.
- *Risk:* chunk write cost on the hot path. *Mitigation:* `writeChunk` is one insert; embed is `isEmbedderActive()`-guarded and off by default → zero cost on the default path.

**Roles.** Principal Engineer implements + writes the test. TPM verifies the acceptance test asserts both the embedded-on and off-path-unchanged conditions. LEAD (me) reviews that the write is scoped to `currentProject` (not the effective/combined set — matches the write-attribution rule §11.6, `attend.ts:472`).

---

### S2 — Read path: query router (STRUCTURED → exact-first unchanged; OPEN → semantic-primary), chunks in `AttendResult`

**Goal.** Classify each read deterministically. STRUCTURED (a known entity+key / alias / correction is in play) keeps today's exact-first + lexical + CORE-16 slot-fill path **byte-identical**. OPEN (natural-language recall with no key to look up) additionally runs `searchChunksSemantic` over the project's chunk pool and surfaces the hits in a new `AttendResult.chunks[]`. Semantic is **primary/additive for OPEN**, never a gatekeeper of the fact path (PRD D-PRIMARY, D-ROUTE).

**Files to touch.**
- `src/mcp/tools/attend.ts` — (a) a small deterministic `classifyQuery(input)` helper (rule-based, no LLM — PRD G1): STRUCTURED when entity hints resolve an exact key or an alias/correction fires; OPEN otherwise. (b) In the read side, for OPEN (and when `isEmbedderActive()`), call `searchChunksSemantic(input.message, K, "default", effectiveProjectIds-or-currentProject)`. (c) Extend the `AttendResult` interface (`:308`) with `chunks: Array<{ content: string; score: number }>` (additive, omitted-when-empty to preserve payload shape — same "ball in pool" convention as `semantic?: true` at `:328`). (d) Emit it in the output assembly (`:941`).
- Import `searchChunksSemantic` from `../../library/chunks.js`.

**Pattern to mirror (cite).** The **read-then-surface** shape of CORE-16: `readRelevantFactsWithMatch` is called in the read side (`attend.ts:558-570`) and its `matchedIds`/`semanticIds` are threaded into the output map (`:947-955`). Mirror that: call `searchChunksSemantic` in the read side, thread its hits into a `chunks[]` block in the return object. For the "additive, omit-when-empty, off-path-identical" field discipline, mirror `semantic?: true` (interface `:321-328`, emission `:954`). Project-scoping mirrors `chunks.ts:147 fetchChunkCandidates` (already project-scoped) and `getEffectiveProjectIds` (`attend.ts:473`).

**Written measurable acceptance criterion.** Integration test (mock embedder, temp PGlite): (1) seed via `attend` two chunks with zero-keyword-overlap paraphrase fixtures (reuse `chunks.test.ts:43-51` `RELATED_CHUNK`/`PARAPHRASE_QUERY`/`OTHER_CHUNK`); (2) an **OPEN** query (the paraphrase, no entity+key) returns `AttendResult.chunks[0].content === RELATED_CHUNK` with `score > 0.6`; (3) a **STRUCTURED** query (known entity+key) returns the exact fact via `facts[]` and its `chunks[]` behavior matches the router's STRUCTURED contract; (4) **byte-identical guard:** for the STRUCTURED path and for the embedder-off path, `facts[]`/`matched`/`semantic` output is unchanged vs pre-S2 (snapshot), and `pnpm bench` off = 0.0pp. **Target rung: TESTED.**

**Risks + mitigations.**
- *Risk (highest-design):* the router misclassifies, silently demoting exact-first (the thing PRD §8 forbids). *Mitigation:* router is deterministic + rule-based + unit-tested per branch; STRUCTURED path code is **untouched** (chunks are additive, not inserted into the fact ranking) so a misroute can only *add* chunk context, never *remove* a fact hit. Assert this explicitly in the byte-identical test.
- *Risk:* scope choice (currentProject vs effective/combined). *Mitigation:* reads span the effective set everywhere else (`:473`); use `effectiveProjectIds` for chunk reads for consistency, and test cross-project isolation (mirror `chunks.test.ts:118`).
- *Risk:* K / budget interaction with fact budget. *Mitigation:* chunks get their OWN K (they are a separate output array, not competing for the fact budget) — decision recorded here so it is not silently entangled with `MAX_FACTS_PER_ENTITY`.

**Roles.** Principal Engineer implements router + read wiring + `chunks[]` output + tests. TPM verifies the STRUCTURED/off byte-identical assertions actually run and pass (this is the "structured path unchanged" §7 criterion). LEAD reviews the router's STRUCTURED-vs-OPEN rule against D-ROUTE — specifically that exact-first is never demoted.

---

### S3 — Abstention gate: below-floor + no fact hit ⇒ signal "not enough information"

**Goal.** Make never-invent first-class at retrieval time (PRD D-ABSTAIN / G4). When, for an OPEN query, the top chunk is below the similarity floor (i.e. `searchChunksSemantic` returned `[]`) **and** the fact layer produced no matched hit, `AttendResult` carries an explicit abstention signal so the host declines rather than padding an answer from an irrelevant chunk/ambient fact.

**Files to touch.**
- `src/mcp/tools/attend.ts` — add `abstain: boolean` (or a small `{ abstain: true, reason }` shape, omitted-when-false) to `AttendResult` (`:308`), computed after the read side: `abstain = isOpenQuery && chunkHits.length === 0 && matchedFactIds.size === 0`. Emit in output assembly (`:941`).

**Pattern to mirror (cite).** The abstention primitive already exists **inside** `chunks.ts`: `searchChunksSemantic` returns `[]` below floor — "that empty result IS the abstention signal" (`chunks.ts:168-173`, tested `chunks.test.ts:82-99`). S3 only *lifts that empty-result fact to the `AttendResult` surface* and conjoins it with the existing `matchedFactIds` emptiness (`attend.ts:550`, the "no-answer honesty" set already threaded to `facts[].matched`). Mirror the existing "all-matched-false = iranti saying nothing answers that" doctrine documented at the interface (`:316-320`) — S3 makes it an explicit boolean instead of an inference the host must make.

**Written measurable acceptance criterion.** Integration test (mock embedder): (1) seed one on-topic chunk; a **gibberish** OPEN query (reuse `chunks.test.ts:91` fixture) with no matching fact ⇒ `AttendResult.abstain === true` and `chunks` empty and no `matched` fact. (2) A **paraphrase** OPEN query that DOES retrieve a chunk ⇒ `abstain` is false/absent. (3) A STRUCTURED query with a real fact hit ⇒ `abstain` false/absent even if chunks are empty (a fact answered it). (4) Off-path: `abstain` absent/false, output byte-identical. **Additionally**, the S5 bench must show the abstention probe class (`*_abs`, e.g. `09ba9854_abs`) resolving as no-answer and `falsePositiveRate` not regressing (that half is MEASURED in S5, not here). **Target rung: TESTED (in-iranti behavior); the abstention-class recovery is MEASURED in S5.**

**Risks + mitigations.**
- *Risk:* over-abstention — declining when a fact actually answered. *Mitigation:* the gate requires **both** no chunk AND no matched fact; a fact hit suppresses abstention. Test case (3) pins this.
- *Risk:* abstention only meaningful when the embedder is on (off-path returns `[]` always). *Mitigation:* only compute/emit `abstain` when `isEmbedderActive()` and the query is OPEN; off-path leaves it absent → today's behavior. Documented on the field.

**Roles.** Principal Engineer implements + tests. TPM verifies the "fact hit suppresses abstention" and off-path-absent cases. LEAD reviews that the abstention definition matches D-ABSTAIN exactly (below-floor AND no fact hit — not either/or).

---

### S4 — Embedder auto-ON-when-reachable (PRD §9 decision), so the recall tier is actually active by default

**Goal.** Encode the ratified §9 decision: **default ON when an embedder is reachable** (endpoint up AND embed model present via a bounded, cached probe), **else silent OFF with a one-time hint** — no crash, no hang on a machine without Ollama. Without this, S1–S3 stay dark for every default install (the exact CORE-16 over-correction CORE-17 exists to undo).

**Files to touch.**
- `src/embed/index.ts` — `getEmbedderMode()` (`:63`): when `IRANTI_EMBEDDER` is unset (not explicitly `off`/`ollama`/`mock`), run a **cached, bounded, fail-closed** reachability probe against the Ollama endpoint (`IRANTI_EMBED_ENDPOINT`) for the embed model; return `ollama` if reachable, else `off`. Explicit `IRANTI_EMBEDDER=off` still forces off (opt-out preserved). The probe result is memoized (one probe per process) and the failure path is silent + instant.
- `.env.example:13` — update the comment to document ON-when-reachable (keep a way to force off).
- Possibly a tiny `src/embed/probe.ts` for the bounded fetch (mirror `OllamaEmbedder`'s endpoint handling in `src/embed/ollama.ts`).

**Pattern to mirror (cite).** The **fail-closed, guard-first** posture is `isEmbedderActive()` (`embed/index.ts:70-72`) — every recall call site already short-circuits on it, so a probe that returns `off` degrades to exactly today's zero-infra behavior with no new branches at call sites. The bounded-timeout fetch mirrors the chunk-rag adapter's `AbortSignal.timeout(...)` discipline (`bench/competitive/adapters/chunk-rag.ts:31`) and `OllamaEmbedder`'s existing endpoint call. The singleton-cache-invalidation reasoning is already documented at `getEmbedder()` (`:84-96`); the probe cache follows the same "cheap, memoized, re-derive on mode change" logic.

**Written measurable acceptance criterion.** Unit test (no live Ollama): (1) probe against an **unreachable** endpoint (e.g. a closed port / mocked fetch rejecting) ⇒ `getEmbedderMode() === "off"` within the bounded timeout (assert it returns fast, not after a long hang), no throw. (2) `IRANTI_EMBEDDER=off` explicitly ⇒ `off` regardless of reachability (opt-out honored, probe skipped). (3) probe against a **reachable** mock endpoint (fetch resolving with the model present) ⇒ `"ollama"`. (4) probe result is memoized (fetch called at most once per process). Manual/observed: on a box with Ollama + `nomic-embed-text`, a default `attend` with no `IRANTI_EMBEDDER` set now embeds+retrieves chunks (this is exercised for real by S5's ON cell). **Target rung: TESTED (probe logic) + WIRED (default install activates the tier); its recall payoff is MEASURED in S5.**

**Risks + mitigations.**
- *Risk (product-critical):* an auto-ON that spawns hanging Ollama calls on a machine without Ollama breaks the zero-infra guarantee. *Mitigation:* probe is bounded (short AbortSignal timeout), cached (one probe/process), fail-closed (any error → off) — the whole §9 rationale. Test (1) asserts fast + no-throw.
- *Risk:* determinism claim weakens ("deterministic given a pinned local model" instead of pure-code). *Mitigation:* this is disclosed in the audit/PRD; the byte-identical `pnpm bench` guarantee explicitly covers only the off path, and the pinned-model reproducibility criterion (PRD §7 "pinned model ⇒ reproducible") is a separate S5 check.
- *Risk:* probe flakiness misclassifies a momentarily-slow endpoint as down. *Mitigation:* acceptable for v1 (degrades to deterministic-only, no wrong answers); the one-time hint tells the user recall is off so it is observable, not silent-forever.

**Roles.** Principal Engineer implements probe + tests + `.env.example`. TPM verifies the fail-closed/bounded/opt-out cases actually assert timing + no-throw. LEAD reviews that the default-install behavior matches §9 (ON-when-reachable, silent-OFF-else) and that the zero-infra floor is genuinely preserved.

---

### S5 — In-iranti bench cell: measure iranti's OWN retrieval-first recall against the chunk-rag concept test (THE acceptance gate)

**Goal.** Produce **iranti's own** measured retrieval-first recall on LongMemEval-S track H — the number that may finally be quoted as iranti's — by making the harness exercise the wired recall layer end-to-end (write chunks → embed → route → retrieve chunks → surface to the shared reader). This is the acceptance gate for "CORE-17 done."

**Why S1–S4 are insufficient without S5 (the structural blocker).** The only adapter that drives real iranti, `bench/competitive/adapters/iranti-next.ts`, **hardcodes `IRANTI_EMBEDDER: "off"` (`:80`)** and in `query()` reads only `parsed.facts` (`:177-182`) — it never sets an embed endpoint and never surfaces chunks. So even with S1–S4 fully wired, this adapter would still measure the **lexical** path (the 12.5%) and report chunks as invisible. S5 changes the adapter, not just the engine.

**Files to touch.**
- `bench/competitive/adapters/iranti-next.ts` — add a recall-enabled variant (cleanest: a new extractor/mode value, e.g. `IrantiNextExtractor` gains `"recall"`, or a boolean `embed` flag on the factory). For that variant: set `IRANTI_EMBEDDER` **unset/auto (S4) or explicitly `ollama`**, plus `IRANTI_EMBED_ENDPOINT`/`IRANTI_EMBED_MODEL` = the local `nomic-embed-text` Ollama config the chunk-rag adapter uses (`chunk-rag.ts:20-21`) so it reproduces the concept test's stack. In `query()`, when the server returns `chunks[]` (from S2), fold `chunks[].content` into `retrieved[]` (topK-bounded) alongside/instead of facts, so the shared reader (`reader.ts`, D9) scores the same retrieved-context surface the chunk-rag adapter scored.
- `bench/competitive/runner.ts:107-113` (`SYSTEMS` registry) — register the new cell, e.g. `"iranti-next:recall": irantiNextFactory("recall")`, so `BENCH_SYSTEMS=iranti-next:recall,iranti-next:chunk-rag` runs both side by side through identical reader+judge.

**Pattern to mirror (cite).** The adapter contract is fixed by `bench/competitive/types.ts`: `QueryResult.retrieved: string[]` is the **only scored surface** (`:49-61`), and the shared reader+judge are identical for every system (`:91-133`) — so S5 is purely "make iranti's `retrieved[]` contain the chunk hits." Mirror how the existing `iranti-next` `query()` already maps server output into `retrieved[]` (`iranti-next.ts:177-182`) — the change is which server field it reads (add `chunks[]`) and which env it launches under (embedder on). Mirror `chunk-rag.ts`'s embed config (`:20-21`) so the two systems share `nomic-embed-text` and the comparison is apples-to-apples on the same canonical stack. Registration mirrors the existing `SYSTEMS` entries (`runner.ts:108-113`).

**Written measurable acceptance criterion (the CORE-17 gate).** Run `BENCH_SYSTEMS=iranti-next:recall,iranti-next:chunk-rag BENCH_DATASETS=longmemeval-s BENCH_TRACKS=H` on the **same** stratified subsample (record exact n — the existing runs used n=24) with `nomic-embed-text` embeddings and `claude-sonnet-5` reader+judge. Emit a `summary.json` row for `iranti-next:recall`. **Acceptance = iranti-next:recall mean ≥ the chunk-rag adapter's number on the identical subsample+conditions (the ~79.2% concept test), and materially above the 12.5%/18–20% lexical baseline** — proving iranti's OWN recall matches the concept test (PRD §7 line 1). Secondary MEASURED checks on the same run: abstention probes (`*_abs`) resolve as no-answer via the S3 gate without a `falsePositiveRate` regression (§7); STRUCTURED/off `pnpm bench` = 0.0pp (§7); pinned-model reproducibility ×2 (§7). Every reported number carries **n, model (embedder + reader + judge), track, subsample** inline. **Target rung: MEASURED.**

**Risks + mitigations (this stage owns the schedule risk).**
- *Risk (the single hardest — see §4):* the wired in-iranti path does **not** reproduce ~79% (chunk slicing differs from the adapter's whole-session buffering; per-session `writeChunk` vs the adapter's one-chunk-per-`write`; the O(n) 500-cap over PGlite-text vectors vs the adapter's in-memory array; `IRANTI_EXTRACT_SYNC`/timing). *Mitigation:* make the in-iranti chunk unit match the concept test first (embed whole-session content, same 8000-char clamp — `chunks.ts:37` already = `chunk-rag.ts:30`), diff retrieved-context sets case-by-case against the chunk-rag adapter on shared cases to isolate where recall diverges, and treat any gap as a wiring bug to close, not a number to spin.
- *Risk:* cost/time — frontier reader+judge over n=24 × repeats is the real schedule cost, and needs the Ollama box for embeddings. *Mitigation:* start at the existing n=24 subsample (not full 500), reuse the resumable per-question ledger (`types.ts:163-178`, `CellLedger`) so a killed run doesn't re-spend, run the recall cell alongside a fresh chunk-rag cell for a same-conditions comparison.
- *Risk:* honesty — reporting the adapter's 79% as iranti's before this cell passes. *Mitigation:* this plan forbids it (§0, §3); until `iranti-next:recall`'s `summary.json` exists, iranti's only self-number is 12.5%/18–20%.

**Roles.** Principal Engineer implements the adapter variant + registry + runs the cell and pastes the measured `summary.json`. TPM gates: verifies the number is `iranti-next:recall`'s own row (not chunk-rag's), that n/model/track/subsample are stated inline, and that the ≥-concept-test bar is met with evidence attached before "done" is uttered. LEAD reviews the comparison is apples-to-apples (same embedder, same subsample, same reader/judge) and ratifies the number as iranti's.

---

## 3. Definition of CORE-17 done

CORE-17 is **done** only when **all** of the following hold, with evidence attached:

1. **iranti's OWN retrieval-first recall is MEASURED and exists as a number** — a `bench/competitive` `summary.json` row for the recall-enabled iranti adapter (`iranti-next:recall`) on LongMemEval-S track H, reported with its **n, embedder model, reader model, judge model, track, and subsample** inline, and **≥ the chunk-rag concept-test number on the identical subsample+conditions**, materially above the 12.5%/18–20% lexical baseline (S5 acceptance met).
2. **Every stage S1–S4 is at least TESTED** — the write path (S1), read/router + `chunks[]` (S2), and abstention gate (S3) each have a passing integration test asserting their acceptance criterion; the auto-ON probe (S4) has passing unit tests (fail-closed, bounded, opt-out, memoized) and activates the tier on a default reachable install.
3. **No regressions** — `pnpm typecheck` exit 0, `pnpm lint` exit 0, full suite green minus the 2 pre-existing known failures; **`pnpm bench` with the embedder OFF drifts 0.0pp** (the byte-identical-when-off guarantee, PRD §7); the STRUCTURED path is unchanged; abstention adds no `falsePositiveRate` regression; pinned-model retrieval is reproducible ×2.

**Forbidden (non-negotiable, both charters + Honesty charter):** quoting **any** number that is not iranti's own MEASURED one as iranti's recall. Specifically, the **79.2%** (`chunk-rag.ts` bench adapter, `results-chunkrag/summary.json`) is a **validated hypothesis about a design**, NOT iranti's result, and must always be labeled as the concept-test adapter's number with its conditions (n=24, claude-sonnet-5 reader+judge, track H) until S5's `iranti-next:recall` row exists. Until then, iranti's only honest self-number is the lexical **12.5% (heuristic) / 18–20% (frontier)** with the embedder off.

---

## 4. The single hardest risk to completion

**S5's in-iranti path failing to reproduce the ~79% — i.e. the wired-into-iranti recall measurably underperforming the standalone chunk-rag adapter.** The 79.2% was produced by an in-memory adapter with a specific, favorable shape: it buffers **whole sessions** as single chunks, embeds them in one batched Ollama call, and cosine-ranks in a plain in-memory array with no cap and no regime/version machinery. iranti's wired path differs on several axes at once — per-turn/per-session `writeChunk` granularity and whatever content boundary S1 chooses, the regime version-lock + `regimeMatches` filter (`chunks.ts:198`) that can silently drop vectors, the O(n) **500-cap** over PGlite `text`-serialized vectors (`chunks.ts:42,147`) vs an uncapped array, and the fire-and-forget timing under `IRANTI_EXTRACT_SYNC`. Any one of these can cost recall points, and the failure mode is **quiet** (a slightly worse retrieved set the reader still answers *some* of), which is exactly the situation where the temptation to quote the adapter's 79% "because the design is proven" is strongest — the precise dishonesty this team was formed to prevent. It is the hardest risk because it is simultaneously the **acceptance gate** (nothing is "done" without it), **schedule-heavy** (frontier reader+judge + the Ollama box, resumable but not free), and **integrity-sensitive** (the number must be iranti's own or CORE-17 is not done, full stop). Mitigation is to make the in-iranti chunk unit match the concept test's whole-session shape first, diff retrieved-context sets case-by-case against the chunk-rag adapter on shared cases to localize any divergence as a wiring bug, and hold the line that only `iranti-next:recall`'s measured row closes the phase.
