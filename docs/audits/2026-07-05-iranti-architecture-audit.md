# iranti — Architecture Audit

**Date:** 2026-07-05
**Auditor:** system-architect (read-only; investigate + report, no source changed)
**Repo:** `C:/Users/NF/Documents/Projects/iranti`
**Branch audited (deep):** `feat/core-17-retrieval-first` (working tree, dirty)
**Cross-branch:** read-only git across all local + remote branches
**Commission:** Is CORE-17 retrieval-first architecturally sound, and is iranti healthy enough to keep building on? Where are the real risks and the architecture debt?

---

## 0. Bottom line (read this first)

**CORE-17's *direction* is sound and evidence-forced. CORE-17's *current implementation* is a well-built island that is not connected to the product.** The benchmark that motivates it is real and the doctrine (deterministic drives, semantic rides shotgun on open queries) is the right correction to CORE-16's over-implemented "backseat." But the number that justifies the whole phase — **79.2%** — was produced by a *standalone in-memory RAG adapter* (`bench/competitive/adapters/chunk-rag.ts`) that never touches iranti's store, while iranti's own recall in the same harness scored **12.5% / 18%** with the embedder switched **off**. The new chunk machinery (`src/library/chunks.ts`, the `chunks` table, migration 0015) exists, compiles, and is unit-tested — but **has zero callers outside its own test file**: `attend` does not write chunks, does not read chunks, has no query router, no abstention gate, no `chunks[]` output. The PRD's headline acceptance criterion ("recall parity *inside* iranti, not just the adapter") is therefore **not met and not yet measurable**.

Separately, and more urgently as a *process* risk: **all of CORE-17's work is uncommitted.** The branch pointer `feat/core-17-retrieval-first` is byte-identical to `feat/v1-wave1` (`git rev-list --left-right --count v1-wave1...core-17` = `0  0`). Every CORE-17 artifact lives only in the untracked/modified working tree — a single-copy, un-pushed state for a schema migration and a new table.

**Verdict: keep building on this architecture — the foundation (CORE-16 semantic tier, the engine seam, project scoping, the fact/truth layer, the fair-bench discipline) is genuinely strong and I would not rebuild it. But CORE-17 is ~15% done, not "in review." Treat the 79% as a validated *hypothesis about a design*, not a delivered result. The remaining 85% is the integration into `attend` and the honest in-iranti measurement — that is where the phase's risk actually lives.** The healthiest next move is to (a) commit/push the island immediately, then (b) wire the write→embed→retrieve→surface path into `attend` behind a bench cell that exercises `chunks.ts` in-process, and only then re-ratify the 79% claim as iranti's own.

---

## 1. Drivers & how I weighted them

From the master PRD, `docs/decisions/open-decisions.md` (G1–G3), and the CORE-16/17 PRDs, the non-negotiables, weighted:

| # | Driver | Weight | Where it lives in code |
|---|--------|--------|------------------------|
| G1 | Determinism + never-invent (abstain, don't fabricate) | **Highest** | `facts.ts` slot-fill floor, `SIMILARITY_FLOOR`, `chunks.ts` floor-as-abstention |
| — | Local-first / zero-infra / privacy (PGlite default, no signup) | **Highest** | `db/connection.ts` engine seam, PGlite auto-migrate, `IRANTI_EMBEDDER=off` default |
| — | Recall accuracy (the benchmark bottleneck) | **High (the CORE-17 thesis)** | `bench/competitive/`, `chunks.ts` (unwired), `facts.ts` semantic tier |
| G1 | Correctability + provenance + auditability | High | `fact_archive`, supersession, `entity_aliases`, `matched`/`semantic` labels |
| — | Low cost | Medium | embedder-off default, extraction cache (AX-2), heuristic-first extraction |
| G2 | Host/model portability + multi-host lifecycle | Medium | MCP tool surface, attend phase protocol, `surface` provenance column |

The tension CORE-17 manages is **recall accuracy vs. determinism/never-invent**. The whole audit turns on whether the new code respects G1 while chasing recall. It does — the floor-as-abstention design is correct. The problem is not doctrine; it is *completeness*.

---

## 2. Architecture map + the end-to-end trace

**Shape:** MCP server (stdio + HTTP, one shared tool registry `src/mcp/register.ts`) → tool handlers (`src/mcp/tools/*`) → library layer (`src/library/*`, the domain logic) → Drizzle over a single `db` union (`src/db/connection.ts`) → PGlite (default) or postgres-js. Cross-cutting: `src/embed/` (CORE-16 semantic), `src/extract/` (heuristic + local/frontier LLM), `src/graph/` (co-access/governs edges), `src/harness/` (internal golden bench) and `bench/competitive/` (the fair competitive harness).

**One full write→store→embed→retrieve→surface trace, followed in code:**

1. **Host calls `iranti_attend`** (`register.ts:89` → `attend()` in `mcp/tools/attend.ts:461`).
2. **Write side** — `extractArtifacts(message)` pulls URLs/paths (`attend.ts:484`); each is `writeFact`'d (`attend.ts:489`). Declared aliases are `learnAlias`'d (`attend.ts:509`).
3. **`writeFact`** (`library/facts.ts`) upserts the fact row, and in a `trackBackground` post-commit chain fires **`embedFactOnWrite`** (`facts.ts:511`, `embed/write-hook.ts:18`) — embeds `key + ": " + value`, writes the vector through the single accessor (`embed/vector-column.ts:71`) and the regime signature into `metadata.embedRegime`. No-op when `IRANTI_EMBEDDER=off` (the default).
4. **Read side** — `readRelevantFactsWithMatch` (`facts.ts:878`) does keyword scoring, then **`fillRemainingWithSemantic`** (`facts.ts:830`) slot-fills leftover budget with above-floor cosine hits from the entity's *own* candidate pool (`fetchSemanticCandidates`, `facts.ts:733`), labeled `semantic: true`, never `matched: true`. Alias resolution (`attend.ts:579`) guarantees a nickname's target wins rank-1.
5. **Graph-hop peripheral** tier (`attend.ts:695`), checkpoint, project-state rollup, media tier.
6. **Surface** — `AttendResult` assembled (`attend.ts:941`) with `facts[]` (each carrying `matched`/`semantic`), `peripheral[]`, `corrections[]`, `media[]`, `projectState`. Post-response, a `trackBackground` chain runs LLM extraction, edge recording, attend-log, metrics (`attend.ts:866`), settled at teardown by `closeDb`'s `settleBackground(5000)` (`connection.ts:134`).

**Where CORE-17 *should* appear in this trace and does not:** step 3 should also `writeChunk` + `embedChunkOnWrite` the raw turn; step 4 should route OPEN queries to `searchChunksSemantic`; step 6's `AttendResult` should carry `chunks[]` + an abstention signal. **None of these exist in `attend.ts`** (`grep chunk src/mcp/tools/attend.ts` → no match). The trace for chunks dead-ends at the unit test.

---

## 3. Ranked risks (impact × likelihood)

### R1 — CORE-17 is unwired: the chunk recall layer has no caller in the product. **[Impact: critical · Likelihood: certain — it is the current state]**

**What.** `src/library/chunks.ts` exposes `writeChunk`, `embedChunkOnWrite`, `searchChunksSemantic`. The *only* callers anywhere are `src/tests/chunks.test.ts`. Verified:
- `grep -rn "searchChunksSemantic|writeChunk|embedChunkOnWrite"` → matches only in `chunks.ts` (defs) and `chunks.test.ts`.
- `attend.ts` contains **no** reference to chunks (`grep chunk src/mcp/tools/attend.ts` → nothing).
- `search.ts` / `query.ts` contain no chunk reference.
- No `iranti_*chunk*` tool is registered (`register.ts` full tool list: attend, write, write_rule, rules_list, rule_deactivate, aliases_list, alias_archive, archive, search, checkpoint, history, query, write_issue, ingest_media, project_state, project_status, project_combine/uncombine/exclude/include — no chunk surface).

**Which PRD promises this and is unmet.** `core-17-retrieval-first-recall.md §7` acceptance criteria: "query router in `attend`", "`AttendResult` gains `chunks[]`", "explicit abstention signal", "raw session chunk embedded fire-and-forget on write". §7 line 1: *"iranti-next with CORE-17 on LongMemEval-S track H ≥ the chunk-rag adapter's 79.2%… The point of the redesign is that iranti's own recall matches the concept test."* Today iranti's own recall path is byte-identical to pre-CORE-17.

**Which driver it threatens.** Recall accuracy (the entire thesis of the phase is undelivered) and, indirectly, the credibility of the 79% claim (R2).

**Is it "wrong" or a "trade-off"?** Neither — it is **honestly incomplete**. The PRD was *ratified today* (2026-07-05) and explicitly says "implementation opens with §7 acceptance as failing bench targets." What I am flagging is a **status-perception risk**: the module's polish (218 LOC, full comments, 4 green integration tests, clean typecheck) makes it *look* finished. It is the scaffold, not the feature. A reader skimming `chunks.ts` would over-estimate CORE-17's completion by ~5×.

**Concrete remediation + cost.**
1. Write side: in `attend.ts` (post-response phase), `trackBackground(writeChunk(...).then(id => embedChunkOnWrite(id, content)))` on the raw turn, scoped to `currentProject`. (~15 LOC, mirrors the existing `embedFactOnWrite` pattern exactly.)
2. Read side: a deterministic query router (STRUCTURED vs OPEN — the PRD's G1) and, for OPEN, call `searchChunksSemantic`, thread results into a new `AttendResult.chunks[]` + abstention flag. (~60–100 LOC + the router.)
3. A bench cell that drives `iranti_attend` with the embedder ON and measures the in-iranti number vs the 79% adapter. (This is the real acceptance evidence and the only thing that closes R2.)
- **Rough cost:** 1–2 focused days for the wiring; the honest measurement run is the schedule risk (frontier-judge time), not the code.

---

### R2 — The 79.2% headline was produced by a bypass adapter, not by iranti. **[Impact: high · Likelihood: certain]**

**What.** The number driving CORE-17's business case is `bench/competitive/results-chunkrag/summary.json`: `mean 0.7917, runs 1, variance 0`. Its `system` is `"iranti-next:chunk-rag"` — but that adapter (`bench/competitive/adapters/chunk-rag.ts:61`) is an **in-memory `Map`-based RAG** that buffers raw conversations, batch-embeds them via a direct Ollama HTTP call, and cosine-ranks in a local array. It has an explicit header: *"Bench-only, NO iranti source changes… NOT the production design (that reuses CORE-16 inside iranti's store) — this is the concept test on the canonical stack."* It never imports `src/library/chunks.ts`, never opens the `chunks` table, never calls `attend`.

Meanwhile the adapter that *does* exercise iranti (`adapters/iranti-next.ts:80`) runs with `IRANTI_EMBEDDER: "off"` and retrieves through `iranti_attend`'s keyword path — that is the config that scored **12.5% (heuristic)** / **18% (frontier)** (`results-lmeval/`).

**So the comparison "12–18% → 79%" is real but is *lexical-iranti* vs *a different system entirely*, not before/after on one system.** It proves *semantic-over-chunks beats lexical-over-facts on this workload* — a genuine and important finding — but it does **not** yet prove iranti can hit 79% once wired. That is a reasonable hypothesis (same embedder, same chunk-slicing, same reader) but it is unproven until `chunks.ts` is in the loop.

**Additional honesty caveats already disclosed in the PRDs (good) but load-bearing here:** the run is **n=1, variance 0, temp-0** with **claude-sonnet-5 as both reader and judge** (`summary.json:12-15`), over a **24-question stratified subsample** (`bench-1` changelog + `core-17` PRD §1 "n=24"), not the full 500. BENCH-1's own §9 flags the claude-vs-published-GPT-4o judge/reader confound. None of this is hidden — but it means 79.2% is a **single-point estimate on a subsample by a frontier judge grading a frontier reader over a non-iranti retriever.** It is directionally strong, not a robust product metric.

**Which driver it threatens.** Correctability/honesty of the instrument (the thing BENCH-1 exists to protect) and the soundness of the go-forward decision if 79% is read as "iranti scores 79%."

**Remediation.** Gate CORE-17 "done" on the in-iranti bench cell from R1.3. Until then, everywhere the 79% appears, label it exactly as the adapter header already does: *"concept-test on the canonical stack; iranti's own number pending wiring."* (The PRD mostly does this; keep it disciplined in any pitch/report.)

---

### R3 — All CORE-17 work is uncommitted and single-copy. **[Impact: high · Likelihood: certain now; the loss event is the risk]**

**What.** `git rev-list --left-right --count feat/v1-wave1...feat/core-17-retrieval-first` = **`0  0`** — the CORE-17 branch pointer is *identical* to `v1-wave1`'s HEAD (`34c6f17c`). Every CORE-17 artifact is in the **working tree only**:
- Untracked: `src/library/chunks.ts`, `src/tests/chunks.test.ts`, `drizzle/0015_condemned_miracleman.sql`, `drizzle/meta/0015_snapshot.json`, `docs/prds/phases/core-17-retrieval-first-recall.md`.
- Modified-unstaged: `src/db/schema.ts` (the `chunks` table), `src/db/connection.ts` (the 0015 PGlite override), `drizzle/meta/_journal.json`.

There is no commit, no branch divergence, nothing pushed. A `git checkout .`, a bad `git stash drop`, a disk failure, or an accidental `git reset --hard` loses a **schema migration + a new table + its accessor + its tests** with no second copy. This is a governance gap, not an architecture flaw, but it is the single most *likely-to-hurt-today* item in this report.

**Remediation.** Commit now on the branch, push. Cost: minutes. (Explicitly out of scope for me to do — read-only audit — but it is the #1 action.)

---

### R4 — The CORE-17 §9 "embedder ON-when-reachable" decision is not implemented; default is still OFF. **[Impact: medium · Likelihood: high]**

**What.** CORE-17 §9 records a *decided* behavior: *"default ON when an embedder is reachable (endpoint up AND embed model present via probe), else silent OFF with a one-time hint."* That is the operative mechanism that makes "vector rides backseat, not off" true for real users. In code, `getEmbedderMode()` (`embed/index.ts:63`) returns `off` unless `IRANTI_EMBEDDER` is explicitly `ollama`/`mock`; there is **no reachability probe**, and `.env.example` still ships `IRANTI_EMBEDDER=off`. So even after R1 is wired, the recall layer stays dark for every default install — the exact CORE-16 over-correction CORE-17 was written to undo.

**Which driver.** Recall accuracy vs zero-infra. The decision *is* the reconciliation; without it, CORE-17 either doesn't fire (embedder off) or requires manual env config (friction the phase explicitly rejected).

**Trade-off note.** There's a real tension the probe must respect: an auto-ON that spawns Ollama calls on a machine without Ollama must degrade *silently and instantly* (today's zero-infra behavior), not hang or error. The `isEmbedderActive()` short-circuit already gives the safe floor; the probe needs a cached, bounded, fail-closed reachability check. **Cost:** ~½ day, and it is a prerequisite for CORE-17 delivering anything to a default user.

---

### R5 — `bench/competitive/.data/` PGlite stores + a stray root data-dir are untracked-but-unignored clutter. **[Impact: low-medium · Likelihood: medium]**

**What.**
- `bench/competitive/.data/iranti-next-frontier/base/1/...` — a full PGlite/Postgres data directory (hundreds of relation files) sits in the tree. It *is* covered by `bench/competitive/.gitignore` (`.data/`), so it won't be committed — fine.
- **`UsersNF.irantidb-next/`** at the repo **root** — a PGlite store (`PG_VERSION` + `base/`) created by a mangled `IRANTI_DATA_DIR` (the `.mcp.json` iranti-next entry sets `IRANTI_DATA_DIR=C:\Users\NF\.iranti\db-next`; something resolved it to a literal relative `UsersNF.irantidb-next` — a Windows path-join artifact). It is **not** git-ignored (`git check-ignore` → not ignored). A careless `git add -A` would commit a binary WASM database into the repo.
- `bench/competitive/results-chunkrag/` and `results-lmeval/` are untracked and **not** matched by `bench/competitive/.gitignore` (which lists `results/`, `results-smoke/` but not these two names) — so they show up in `git status` as untracked noise, and the `.gitignore` has drifted from the actual result-dir names.

**Which driver.** Repo hygiene / auditability (not architecture). Low blast radius but a real "accidentally commit a database" foot-gun via the root dir.

**Remediation.** Add `UsersNF.irantidb-next/` (and ideally a broad `*.irantidb-*`/`base/`-guard) to `.gitignore`; extend `bench/competitive/.gitignore` to `results-*/`; investigate the Windows path-join that produced the root dir (likely a `path.resolve` on a `\`-stripped env value somewhere in a bench spawn). Cost: minutes for the ignore; ~1hr to root-cause the path bug.

---

### R6 — Latent regime-version coupling between fact-vectors and chunk-vectors. **[Impact: low · Likelihood: low, but silent when it bites]**

**What.** `chunks.ts` reuses `buildEmbedRegime` / `regimeMatches` wholesale. `buildEmbedRegime` bakes in `EMBED_TEXT_VERSION` (`embed/regime.ts:21`), documented as *"bump whenever the embed-text composition changes (`key + ": " + value` today)."* But chunks embed **raw content**, a different composition, while carrying the **same** `EMBED_TEXT_VERSION="1"`. Facts and chunks are never cross-cosined (separate tables), so it's harmless now — but the coupling means a future bump made for a *fact*-composition change would needlessly invalidate every *chunk* vector (forcing a full re-embed of the bulkier chunk store), and vice versa. The version tag conflates two independent composition regimes.

**Remediation (cheap, do it before scale).** Give chunks their own `CHUNK_EMBED_TEXT_VERSION` (or a `surface: "fact"|"chunk"` field folded into the regime). ~5 LOC. Label: *defensible-for-now, but I'd decouple it before chunk volume makes re-embeds expensive.*

---

## 4. Non-risks — what is genuinely well-built (protect these)

These are audited with the same rigor as the risks; they are the reason the answer to "keep building?" is yes.

**N1 — The engine seam (`db/connection.ts`) is excellent architecture.** One `db` union + one pool-shaped `end({timeout})` shim lets ~20 call sites stay engine-agnostic across PGlite and postgres-js (`connection.ts:58-148`). The PGlite auto-migrate reimplements Drizzle's transactional migrator *faithfully* (one BEGIN/COMMIT over the pending set, same `__drizzle_migrations` bookkeeping, rollback-on-throw) so a crash mid-migration doesn't brick a zero-infra data dir (`connection.ts:286-332`). The `PGLITE_MIGRATION_OVERRIDES` keyed-by-tag mechanism (`connection.ts:204-235`) solves the "shared migration file, one engine lacks pgvector" problem *without forking the SQL* — the migration file stays pristine for Postgres, PGlite substitutes `text` for `vector(768)` + drops the HNSW index in-memory. This is the correct seam for the local-first driver and it now cleanly absorbed CORE-17's `chunks` table (override at `connection.ts:215`) with no new engine branching. **This is load-bearing and I would not touch it.**

**N2 — The CORE-16 semantic tier is the reference implementation CORE-17 should mirror — and it *is* fully wired.** Unlike chunks, `embedFactOnWrite` is genuinely called from `writeFact` (`facts.ts:511`) and `fillRemainingWithSemantic` from the read path (`facts.ts:997`). The design honors G1 precisely: fixed floor (not tuned) as an abstention gate; `semantic:true` never conflated with `matched:true`; regime version-lock so cross-model cosine is impossible; slot-fill-only so a deterministic hit is never displaced; and a documented **byte-identical-when-off** guarantee with the zero-score-padding ordering fix (`facts.ts:954-1006`) that keeps `pnpm bench` deterministic. The single vector-column accessor (`embed/vector-column.ts`) isolates all engine-conditional cast logic to one file. This is careful, correct, quality-attribute-driven work.

**N3 — The fact/truth layer's correctability is real, not aspirational.** `fact_archive` append-only history, `superseded_by_correction` supersession (`attend.ts:225`, Layer 0i), `entity_aliases` with `factKey`-not-`factId` pointers so aliases survive supersession (`schema.ts:947` header), never-hard-delete everywhere (archive = `isActive=false`). The `matched` label was *tightened* after a measured over-claim (7/8 no-answer probes falsely matched → now requires a key-token hit, `facts.ts:979-991`) — that is exactly the "measure, then correct doctrine" discipline the project claims.

**N4 — Project scoping (Layer 0) is a clean, first-class dimension, not an overloaded tenant.** `project` is its own column on every scoped table with its own unique constraints and indexes (`schema.ts`), `getEffectiveProjectIds` spans combined projects on reads while writes stay pinned to the current project (`attend.ts:472-473`, §11.6). Isolation-by-default with explicit reversible combine/exclude. The `chunks` table correctly inherited the same `(tenantId, project)` scoping and the cross-project isolation is unit-tested (`chunks.test.ts:118`).

**N5 — The competitive-bench methodology (BENCH-1) is unusually honest for a self-benchmark.** The PRD explicitly refuses to import contested vendor numbers, builds one `Adapter` interface so the driver never special-cases a system, inserts a *shared reader stage* (D9) so systems are scored on retrieved-context quality not answer-writing, and openly documents the claude-vs-GPT-4o judge confound and the N=1-under-temp-0 revision. This is the instrument that *caught* the extraction-vs-retrieval misallocation — its existence is a strong signal of engineering maturity. The one caveat is R2: the instrument is honest, but the 79% must be read as the adapter's, not iranti's.

**N6 — Teardown/lifecycle correctness (RULE-2 / SW-1).** The fire-and-forget chains are `trackBackground`'d and settled with a bounded 5s wait before the single PGlite connection closes (`connection.ts:134`), with a single settle-point (double-settle bug already found and fixed). The exclusive data-dir lockfile with pid-liveness + atomic takeover + release-on-post-acquire-failure (`connection.ts:110`, `246-339`) is careful concurrency work for a single-writer embedded store.

---

## 5. Sensitivity & trade-off points

- **[Trade-off] JS cosine over a 500-cap, no ANN index (both facts and chunks).** `SEMANTIC_CANDIDATE_CAP`/`SEMANTIC_CHUNK_CAP = 500`, O(n) scan with a logged truncation note as the named escalation trigger (`facts.ts:731`, `chunks.ts:42`). **Correct call for personal scale** and the escalation (Postgres + pgvector/HNSW, for which the seam already exists) is explicitly named, not hand-waved. The sensitivity: chunks are ~100× bulkier than facts (PRD §9), so the 500-cap is reached far sooner for chunks — the truncation log will fire at a project size that is plausible for a heavy user, and at that point recall silently degrades to "whichever 500 chunks sorted first by id" (id-order, i.e. *arbitrary*, not recency or relevance). This is the sensitivity point I'd watch first after wiring.
- **[Trade-off] Chunk decay/pruning is unbuilt (PRD §9, "own follow-up").** Storing every raw turn verbatim + embedded is unbounded growth. Fine to defer for v1, but it is the difference between "works in a demo" and "works after 6 months of dogfooding." Named honestly.
- **[Sensitivity] The whole recall thesis hinges on Ollama-for-embeddings being reachable.** `nomic-embed-text` via Ollama is the assumed default runtime (OD-2). If that friction is real for users, the recall layer never fires and iranti degrades to the 12–18% lexical path — the exact number the phase exists to beat. The bundled-ONNX escape is named (CORE-16 §9) but unbuilt. This is the biggest *product* (not code) risk under CORE-17.
- **[Trade-off] Determinism of retrieval now depends on a pinned model, not pure code.** CORE-16/17 correctly version-lock and treat cross-regime vectors as absent, so "same text + same model ⇒ same vector ⇒ reproducible" holds. But the byte-identical `pnpm bench` guarantee only covers the *embedder-off* path. Once CORE-17 defaults ON (R4), the flagship determinism claim becomes "deterministic *given a pinned local model*," a weaker (still defensible, still disclosed) guarantee. Worth stating plainly in the pitch.

---

## 6. Cross-branch coherence

*(Read-only git only: `git log`, `git diff --stat`, `git show`, `git rev-list`, `git merge-base`. Working tree left exactly as found. A dedicated read-only git-forensics pass corroborated every count below.)*

**The single most clarifying fact: the repo has TWO disconnected root commits (a history reboot).**
- Modern root `69f3def9` (2026-06-06, *"init: iranti-core rebuild"*) — the Drizzle/PGlite stack, all current work.
- Legacy root `32299e3d` (2026-02-28) — the old Prisma stack (v0.2.x/0.4.x).
- `git merge-base --all main release_v0_2_44_bundle` → **no common ancestor** (same for main↔legacy/prisma, main↔staff-emitter).

**This means the scary-looking "97 / 159 / 334 commits ahead" numbers on the legacy/release/staff branches are an artifact of comparing across unrelated histories — NOT real divergence.** They are a cleanly severed graveyard, not unmerged risk. Distinguishing this from genuine drift is the whole point of the pass.

**The active trunk is one linear chain.** Everything under development collapses to:
`main (cd58eafe)` —+11→ `feat/dogfood-remediation-1 (fabe2f44)` —+30→ `feat/v1-wave1 = feat/core-17-retrieval-first (34c6f17c)`.

- `main...v1-wave1` = **`0  41`**; `main...core-17` = **`0  41`**; **`v1-wave1...core-17` = `0  0`** (same SHA — `git diff v1-wave1..core-17 --stat` is empty). CORE-17 doesn't just fork "off" v1-wave1; it **is** v1-wave1 (R3).
- `merge-base(main, v1-wave1)` = `cd58eafe` = **main's own HEAD** → v1-wave1 is a clean fast-forward descendant; `rev-list main ^v1-wave1` = 0.
- `main` HEAD `cd58eafe` (2026-07-03) is a **docs-only** commit and **lacks the entire `src/embed/` tree** (`git cat-file -e main:src/embed/index.ts` → absent): no CORE-16, no semantic tier, no chunks. 51 non-test source files on main vs 63 in the CORE-17 tree; `main..core-17 --stat` = **90 files, +11,280/−234**.

**No parallel duplication.** The hotspot files (`facts.ts +419`, the new `src/embed/*` ~500 LOC, `attend.ts +69`, `schema.ts +24`, `connection.ts +73`) are heavily rewritten — but on **one lineage**. Every `feat/layer0*`, `feat/checkpoints`, `feat/entity-resolution`, `feat/project-scoping`, `feat/rules-enforcement`, both `fix/*`, and `dogfood/report-1` return **0** from `rev-list <branch> ^main ^v1-wave1 ^core-17` — they are already-absorbed stacked ancestors, not divergent forks. The concerning pattern (two live branches both rewriting `facts.ts`/`schema.ts`) is **absent**.

**The two genuine cross-branch liabilities:**
1. **`main` is trunk-by-topology but 41 commits stale-by-content, tipped by a docs commit.** A fresh clone / CI / any publish step would build a snapshot with **no semantic tier at all**. This is the real risk — not conflicting forks, but that the branch tooling defaults to does not reflect the architecture. **Fix: promote v1-wave1/core-17 to main.**
2. **`feat/staff-event-emitter-injection` is the ONE real orphan — 111 commits, but on the abandoned Prisma root** (`rev-list … ^main ^v1-wave1 ^core-17` = **111**; merge-base with main = none; package.json v0.2.17, `@prisma/adapter-pg`). Its intent (`feat: inject IStaffEventEmitter into Staff components`) may never have been re-ported into the Drizzle rebuild. Git shows it as strand­ed: it would have to be **re-ported, not merged**. **Fix: a conscious "port or abandon" decision.**

**Scratch/graveyard (safe to prune):** `claude/eager-herschel-ad3151`, `claude/zen-poincare-e1d287`, `worktree-agent-adcab104…` all sit *exactly* on main's HEAD (`cd58eafe`) with zero unique commits — throwaway agent worktree pointers. `legacy/prisma-0.4.x` (Prisma 7.x, 334 legacy-lineage commits) and `release_v0_2_43/44_bundle` + `feature_instance_dependencies` (Prisma 0.2.x release snapshots, sharing the legacy root among themselves) are archival.

**Coherence verdict.** **Converging hard toward a single trunk — the apparent sprawl is a history-reboot illusion, not live drift.** One healthy linear Drizzle trunk + a cleanly severed Prisma graveyard. Actionable items: promote main; decide port-or-abandon on staff-emitter; prune the zero-delta scratch pointers; and — the item that isn't even a branch yet — commit CORE-17 (R3).

---

## 7. Architecture-debt inventory

| Item | Type | Where | Severity |
|------|------|-------|----------|
| CORE-17 chunk layer has no product caller | Missing integration (not debt yet — incomplete feature) | `chunks.ts` ↔ `attend.ts` | Critical (R1) |
| `main` is 41 commits behind real trunk (docs-tipped), lacks `src/embed/` | Branch/trunk drift | `main` vs `v1-wave1` | High (§6) |
| CORE-17 uncommitted, single-copy | Governance | working tree | High (R3) |
| `feat/staff-event-emitter-injection` — 111 commits stranded on Prisma root | Un-ported legacy intent | orphan branch | Medium — needs port-or-abandon call (§6) |
| §9 "embedder auto-ON" decided, not coded | Decision-vs-code gap | `embed/index.ts:63`, `.env.example` | Medium (R4) |
| Root `UsersNF.irantidb-next/` data dir, unignored | Hygiene / foot-gun | repo root, `.gitignore` | Low-Med (R5) |
| `bench/competitive/.gitignore` drift (`results-*`) | Hygiene | that file | Low (R5) |
| Fact/chunk share one `EMBED_TEXT_VERSION` | Latent coupling | `embed/regime.ts:21` | Low (R6) |
| Chunk decay/pruning unbuilt | Deferred (named) | PRD §9 | Low now, grows |
| `sessions.turnCount` written-never-read (documented dead column) | Minor cruft (self-documented) | `schema.ts:81` | Trivial |
| Bundled-ONNX embedder escape unbuilt (Ollama friction risk) | Deferred (named) | CORE-16 §9 | Product risk |

**The disease vs the symptoms:** almost everything here is a *symptom of one root cause* — **CORE-17 is at day-one of implementation but its scaffold is polished enough to read as finished.** There is no systemic architecture rot: boundaries are in the right places (library/tool/db seams are clean, the engine seam is exemplary, project scope is first-class). The debt is *completion debt and governance debt*, not *structural debt*. That is the good kind — it pays down by finishing the wiring and merging trunk, not by refactoring.

---

## 8. Direct answer to the commissioning decision

**Is CORE-17 retrieval-first architecturally sound?** **Yes, as a design.** Routing OPEN queries to semantic-over-chunks while keeping exact-first for STRUCTURED queries is the correct reconciliation of the benchmark evidence with G1, and the floor-as-abstention gate is the right way to keep never-invent at retrieval time. The chunk module that exists is well-built and correctly reuses the CORE-16 machinery. I would greenlight the *direction* without reservation.

**Is it *delivered*?** **No — it's ~15% built.** The table, migration, accessor, and tests exist; the product integration (write chunks, route reads, surface `chunks[]`, abstention output, auto-ON embedder) does not. The 79% that justifies the phase is a *different system's* score (a bypass adapter), not iranti's. The headline acceptance criterion is unmet and currently unmeasurable in-product.

**Is the overall architecture healthy enough to keep building on?** **Yes, clearly.** The foundation is strong and coherent: an exemplary local-first engine seam, a fully-wired and G1-respecting semantic tier (CORE-16), a genuinely correctable/audited fact layer, clean first-class project scoping, correct lifecycle/teardown, and an unusually honest measurement culture. There is no Big Ball of Mud, no boundary in the wrong place, no subsystem being rewritten twice in parallel. Change-cost is *low* in the areas most likely to change next, precisely because the seams (embed accessor, engine switch, adapter interface, tool registry) are clean.

**Where the real risk is:** not in the design and not in structural debt, but in **(1) mistaking a polished scaffold for a finished feature, (2) reading a bypass-adapter's 79% as iranti's number, and (3) leaving a schema migration uncommitted and single-copy.** All three are addressable in days, none requires rework.

**Recommendation:** Proceed with CORE-17. First: commit + push the island (minutes). Then: wire write→embed→retrieve→surface into `attend`, add the auto-ON reachability probe, and stand up the in-iranti bench cell that finally measures iranti's *own* retrieval-first recall against the 79% concept test. Treat that in-iranti number — not the adapter's — as the gate for calling CORE-17 done and the number you put in the pitch. Separately, reconcile `main` with the real trunk so tooling and any publish step stop pointing at a 41-commits-stale, no-semantic-tier snapshot.
