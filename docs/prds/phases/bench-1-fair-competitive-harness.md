# PRD: BENCH-1 — Fair Competitive Benchmark Harness

**Status:** proposed
**Phase:** BENCH-1 (competitive-benchmark program, stage S2 onward) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** `docs/plans/2026-07-04-competitive-benchmark.md` (plan of record, Stage Ledger S2–S4, DUAL-TRACK G/H mandate), `docs/research/2026-07-04-memory-benchmark-methods.md` (method catalogue §b–e, fair-suite selection §c, coding-continuity spec §d), Layer 0b PRD (`layer-0b-harness.md`, the internal harness this reuses `Corpus`/`GoldFact`/`scorer.ts` from), `src/harness/types.ts`, `src/harness/scorer.ts`

---

## 1. Summary

iranti's internal bench (`pnpm bench`) grades iranti against its own golden corpus with its own scorer — a real instrument, but not comparable to anything else. This phase builds `bench/competitive/`: one driver, one adapter interface, N per-system adapters, and a dual-track (Track G / Track H) runner that puts iranti and named competitors through the *same* fair-suite datasets (LongMemEval-S, LoCoMo, DMR, iranti's own coding-continuity axis) scored by the *same* LLM judge, and reports a same-scale, defensible number — resumable one milestone at a time, cheapest system first.

## 2. Problem & motivation

Two problems, both surfaced by reconnaissance already done (S1, trust-but-verify already applied, not re-verified here):

1. **No fair instrument exists anywhere on this machine.** Every local bench — `iranti-benchmarking`'s `run_b3a_competitive_recall_v0310.py` (Iranti vs Mem0 vs Shodh) included — grades with naive substring/exact match against a hand-picked fact list, not a published protocol or an LLM judge. `iranti-benchmarking/papers/literature-review-audit.md` itself rules those tracks **not defensible as replications** ("loosely motivated by X"). Building another one repeats a mistake this codebase already caught itself making.
2. **Published competitor numbers are contested, not just unverified.** The research doc documents a live GitHub-issue dispute (Zep's claimed 84% LoCoMo accuracy corrected to 58.44%) and a vendor self-disclosure (MemPalace's top_k=50-vs-32-candidate-pool configuration) — both trace back to an unstated scoring target, k value, or judge prompt. Comparing iranti to a vendor blog number, instead of re-running everyone through the same pipe, would be the same category of error, just imported instead of homegrown.

BENCH-1 is the fix for both: it is S2 ("iranti on the public scale") and the harness S3 ("external adapters") runs against, per the plan's Stage Ledger.

## 3. Goals & non-goals

**Goals**
- One `Adapter` interface (write + query) that iranti-next (3 configs), iranti-old, ai-mem, Mem0, and (once verified) Zep/ByteRover/Shodh/Obsidian all implement, so the driver code never special-cases a system.
- A DUAL-TRACK runner: Track G (industry-gamed config, applied identically to every system) and Track H (single-run, fixed, strict judge) — same datasets, same adapters, two score columns + the per-system G−H gap as a headline result in its own right.
- An LLM-judge component with one fixed prompt per track, reused (not reinvented) from a published source where one exists, N=3 repetitions with reported variance, and byte-for-byte identical treatment across systems.
- A concrete first milestone (iranti-only, zero external installs, S2) that is independently shippable, and a second milestone (ai-mem + iranti, still zero paid accounts) that produces the **first real cross-system number** this program has ever had.
- Every milestone resumable cold: a fresh session can read this PRD + the plan's Stage Ledger and continue from the first unchecked box, per the session-continuity mandate already governing this program.

**Non-goals**
- Running every system in one shot. S3 is explicitly "one at a time, cheapest-first" in the plan; this PRD sequences it, it does not parallelize it.
- Standing up accounts / spending money before NF confirms each keyed system is worth it (Zep/ByteRover/Shodh free-tier verification is a gate, not an assumption — see §9).
- Replacing or modifying `pnpm bench` (the internal golden-corpus harness). BENCH-1 is a sibling tree (`bench/competitive/`), not a rewrite of `src/harness/`.
- Claiming a LoCoMo/LongMemEval number for iranti's coding-continuity axis — that axis is iranti-original and is never labeled with a benchmark name it isn't (see D7).
- Building the full BEAM-1M/MemoryArena/MemBench methods — S1 already scoped these out of the minimal fair suite (docs/research §c); out of scope here too.

## 4. Scope

**In**
- `bench/competitive/adapters/` — one file per system implementing the common `Adapter` interface (§6): `iranti-next.ts` (parameterized by `IRANTI_EXTRACTOR`/frontier key, covering all 3 configs), `iranti-old.ts`, `ai-mem.ts` (wraps the existing `mem2-for-ai-by-ai/bench/mcpclient.mjs` pattern), `mem0.ts` (OSS local SDK).
- `bench/competitive/datasets/` — a LongMemEval-S loader (downloads `longmemeval_s_cleaned.json` from HF `xiaowu0162/longmemeval-cleaned`, MIT; 500 instances; abstention detected via `_abs` question_id suffix), the iranti coding-continuity corpus (new `sessionBoundary` field per docs/research §d, extending `src/harness/types.ts`'s `Corpus` shape), and (M2, deferred) a LoCoMo loader from `snap-research/locomo` (CC BY-NC 4.0 — non-commercial, see §9). DMR loader removed (§9 scout finding). Reader/judge prompts are pulled verbatim from the LongMemEval repo (`src/generation/run_generation.py`, `src/evaluation/evaluate_qa.py`) — provably reused, not transcribed (D4).
- `bench/competitive/judge.ts` — the LLM-judge client: one prompt per track, N=3 runs, variance reporting, temperature/host handling consistent with `src/extract/index.ts`'s existing anthropic-host temperature-omit fix (reused, not reimplemented).
- `bench/competitive/runner.ts` — the dual-track driver: for each (system × dataset × track), call the adapter, call the judge, write one result row.
- `bench/competitive/results/` — one JSON per run, append-only, plus a generated Markdown table (`docs/reviews/<date>-competitive-benchmark-results.md` is S4's job, out of scope here, but the JSON shape this phase emits is what S4 reads).
- `bench/competitive/README.md` — exact install/run commands per adapter (mirrors the plan's "external installs live under `bench/external/<system>/` with a README" convention — see D8 for the directory-naming reconciliation).
- Milestone 1 (S2, this PRD's minimum shippable unit): iranti-next × 3 configs + iranti-old, on **LongMemEval-S (full 500) + coding-continuity**, both tracks. No external installs. (DMR dropped from M1 — see the scout finding in §9: it was never packaged as a downloadable eval set, so any run is a *reconstruction* that would not be comparable to published DMR numbers, defeating its only purpose. LongMemEval-S is the real, cleanly-licensed anchor.)
- Milestone 2 (first stage of S3): + ai-mem adapter, same datasets, same tracks. First real cross-system number.

**Out (deferred, named)**
- Mem0 SDK adapter wiring and its first run — scoped here (adapter file exists in "In" above as a build target) but its *run* is Milestone 3, gated on Milestone 2 landing clean.
- Zep/ByteRover/Shodh HTTP adapters and Obsidian file-vault adapter — Milestone 4+, each gated on its own free-tier/interface verification (S3c/S3d/S3e in the plan).
- LoCoMo's full 10-conversation protocol wiring — included in "In" as a dataset target but its first *run* is deferred to whichever milestone first needs the LoCoMo number (flagged in §9; likely Milestone 2 or 3, not Milestone 1, since LongMemEval-S is the cheaper anchor per docs/research §c).
- S4 synthesis document and cross-system Markdown table — separate PRD-or-direct-task, reads this phase's `results/` JSON as input.
- Revoking the temp Anthropic key — an operational step tracked in the plan file, not a PRD deliverable.

## 5. Design decisions & rationale

- **D1 — One `Adapter` interface, four transport shapes behind it.** Every system implements `write(input) -> WriteResult` and `query(question) -> QueryResult` (§6). Transport varies (MCP stdio for iranti/ai-mem, SDK call for Mem0, HTTP for Zep/Shodh, filesystem for Obsidian) but the driver and scorer never see the difference — they call the two methods and get back the same shape. *Why:* this is the only way the dual-track runner stays one piece of code instead of N. *Rejected:* per-system runner scripts (the `run_b*_v03xx` proliferation already in `iranti-benchmarking/scripts/` — 30+ standalone scripts, no shared interface, exactly the sprawl this PRD exists to not repeat).
- **D2 — Reuse the MCP stdio client verbatim for MCP-shaped systems.** `mem2-for-ai-by-ai/bench/mcpclient.mjs` (~100 lines: spawn, newline-delimited JSON-RPC, request/response by id, loud failure on process exit) is already exactly what an `Adapter` needs for iranti-next, iranti-old, and ai-mem (all three speak MCP). Port it in-place (TypeScript, same shape) rather than writing a new stdio client. *Rejected:* a new client per system — three near-identical stdio clients is the same sprawl D1 rejects, one level down.
- **D3 — Track G and Track H are the SAME adapter calls, different config passed in.** The adapter interface takes a `RunConfig` (top_k, retries/best-of-N, judge-prompt-variant) so Track G's "industry-gamed" settings and Track H's "fixed, strict" settings flow through identical code paths — the *only* difference between the two tracks is the config object and the judge prompt variant, never a special-cased branch per system. *Why:* per the plan, "EVERY system gets the same generous treatment" for Track G — if the config plumbing were per-system, that guarantee would be unenforceable by construction. *Rejected:* separate G-runner and H-runner scripts — doubles the surface for a divergence bug to hide in exactly the place fairness matters most.
  - **D3a — Track G reproduces the industry's generous *settings*, applied uniformly — NOT the industry's per-system cherry-picking (corrected in review).** The plan's rule is "the same generous treatment for every system." So Track G is ONE fixed generous config (a single high `topK` such as 50, best-of-N on, favorable judge prompt) applied byte-identically to all systems — not a per-system `topK` sweep that reports each system's own best number. The per-system sweep is *precisely* the move that inflates vendor leaderboards (MemPalace's 50-vs-32); adopting their generous knobs while refusing their cherry-picking is what makes Track G comparable-to-published without importing the cheat. (This corrects the draft's "tuned high per-system" wording in `RunConfig.topK`.)
- **D9 — One shared reader/answer-generation stage for every system (added in review).** The memory system's *only* scored contribution is the context it retrieves; a fixed reader model + fixed prompt composes the graded answer from that context, identically for all systems (`bench/competitive/reader.ts`, §6). *Why:* this is the published LoCoMo/LongMemEval protocol's "Justify"/QA step. Without it, an adapter that returns a well-written native answer would beat one that returns raw facts on *answer-writing quality*, not memory quality — measuring the wrong variable in exactly the comparison this whole phase exists to get right. `QueryResult.nativeAnswer` is retained for audit but never scored. *Rejected:* letting each adapter return its own scored `answer` (the draft's original shape) — silently confounds retrieval quality with answer-composition quality, and the confound would favor whichever system has the fanciest built-in summarizer, which has nothing to do with memory.
- **D4 — Judge prompt reuse over invention, LoCoMo specifically.** For LoCoMo, use ByteRover's open-sourced `brv-bench` judge/justifier prompts (docs/research §c item 2 — it explicitly supports a `--context-tree-source` flag for plugging in an arbitrary system) rather than authoring a new judge prompt. *Why:* this is the same prompt Mem0/Zep/ByteRover/Hindsight/Memobase/HonCho numbers were already produced with — closes the "which judge, which prompt" fairness gap by construction, and pre-empts the "iranti graded its own homework" objection. For LongMemEval-S, use the dataset's own published GPT-4o-judge prompt (swap only the judge *model*, not the prompt text, to `claude-sonnet-5` per the fairness rule that iranti's judge model choice must not leak into the prompt design). For DMR, a simple correctness check suffices (per docs/research §c item 3 — "smoke test, not a decision-maker"). For coding-continuity, iranti authors its own judge prompt (there is no published one to reuse — flagged honestly as iranti-original, not "the LoCoMo judge applied elsewhere").
- **D5 — N=3 per (system × dataset × track) cell, report mean + spread, not just mean.** Determinism can't be assumed once an LLM judge and, for some systems, an LLM extractor are both in the loop (unlike `pnpm bench`'s byte-identical guarantee, which only holds for iranti's own deterministic layers). Three runs, report [min, mean, max] or stdev per cell. *Why directly ties to the Zep dispute*: the disputed 84% number reportedly came from a single favorable run, not a repeated-and-averaged one — N=3 is the cheapest mitigation that makes "which run did you report" a visible, answered question instead of a silent one. *Rejected:* N=1 (cheaper, but reproduces exactly the failure mode being guarded against) and N=10+ (docs/research flags the Zep dispute involved "single-run vs. ten-run reporting" as a *contested* choice too — N=3 is a deliberate middle point, cheap enough to actually run for every milestone, large enough to expose obvious flukes; revisit upward only if variance at N=3 looks unstable).
- **D6 — Cheapest-local-first sequencing, not size-of-competitor-first.** Milestone 1 = iranti configs only (already-installed, zero new adapters). Milestone 2 = + ai-mem (local, no account, already inspected per S1 recon — the MCP client is right there). Milestone 3 = + Mem0 (local SDK, no account). Milestone 4+ = keyed clouds, gated on free-tier verification. *Why:* matches the plan's explicit sequencing ("External adapters, ONE at a time, cheapest-first") and means Milestone 2 — not some later, more expensive milestone — is the first point this program produces a real number comparing iranti to anything else. *Rejected:* competitor-importance-first (Mem0/Zep first because they're the market leaders) — would delay the first real cross-system result behind the most expensive-to-wire adapters, inverting the plan's stated priority.
- **D7 — Coding-continuity stays on its own labeled axis, permanently.** Its results table column is headed "iranti coding-continuity (iranti-original methodology)" everywhere it appears — never merged into the LongMemEval-S/LoCoMo columns, never described as "iranti's LoCoMo score." *Why:* this is the literature-review-audit's exact failure mode inverted — that audit's tracks were ruled indefensible because they were "loosely motivated by X" while implicitly borrowing X's credibility. Labeling iranti-original work as iranti-original, on a separate axis, is the structural fix, not an afterthought.
- **D8 — Directory name reconciliation: `bench/competitive/` (this PRD) vs. `bench/external/<system>/` (the plan file's phrasing).** The plan file (docs/plans/2026-07-04-competitive-benchmark.md §"Resume/continuity mechanics") says external installs live under `bench/external/<system>/`. This PRD uses `bench/competitive/adapters/<system>.ts` for the *adapter code* (thin, portable, checked in) and reserves `bench/external/<system>/` for the *actual installed competitor repo/binary* where one needs to be vendored locally (e.g., a cloned Mem0 OSS checkout, a Shodh binary) — the adapter imports from or shells out to whatever lives in `bench/external/`. This is additive clarification, not a contradiction: adapter logic and vendored third-party code are different things and belong in different trees. Documented here so a fresh session doesn't see two directory names and assume a conflict.

## 6. Schema / API changes

**New: the `Adapter` interface** (`bench/competitive/types.ts`):

```typescript
export interface RunConfig {
  track: "G" | "H";
  // topK is a SINGLE value applied identically to every system in a track —
  // never swept per-system (D3). Track G: one fixed-generous value (e.g. 50,
  // the MemPalace figure); Track H: one fixed-strict value (e.g. 5).
  topK: number;
  maxRuns: number;             // Track G: best-of-N (report max); Track H: always 1
  judgePromptVariant: "favorable" | "strict";
}

export interface WriteResult {
  ok: boolean;
  latencyMs: number;
  raw?: unknown;               // system-native response, for debugging only, never scored
}

export interface QueryResult {
  // A system's RETRIEVED CONTEXT is its only scored contribution — see the
  // shared answer-generation stage below. `retrieved` is what every system
  // hands to the identical reader model; the harness composes the graded
  // answer from it, so a system with a better built-in answer-writer can't
  // win on composition instead of memory.
  retrieved: string[];         // raw retrieved snippets/facts (topK-bounded)
  nativeAnswer?: string | null; // system's own answer if it returns one — debug/audit ONLY, never scored
  latencyMs: number;
  raw?: unknown;
}

export interface Adapter {
  readonly systemName: string;  // stable id, used as the results-table row label
  write(input: { conversation: string; sessionBoundary?: number }, config: RunConfig): Promise<WriteResult>;
  query(question: string, config: RunConfig): Promise<QueryResult>;
  teardown?(): Promise<void>;   // stop MCP subprocess / close SDK client
}
```

**New: the shared answer-generation stage** (`bench/competitive/reader.ts`) — fairness-critical, added in review (D9):

```typescript
// ONE reader model + ONE prompt per track, applied to EVERY system's
// retrieved context. This is the LoCoMo/LongMemEval "Justify"/QA step: the
// memory system supplies `retrieved`, the reader composes the answer the
// judge then grades. Identical for all systems by construction.
export interface ReaderConfig {
  readerModel: string;         // fixed, e.g. claude-sonnet-5 — same for all systems in a run
  promptRef: string;           // published/fixed prompt id (e.g. brv-bench justifier), recorded in ResultRow
}
export function composeAnswer(
  question: string,
  retrieved: string[],
  config: ReaderConfig,
): Promise<string>;             // -> the answer the judge scores
```

**New: the results row shape** (`bench/competitive/results/<run-id>.json`), one per (system × dataset × track):

```typescript
export interface ResultRow {
  system: string;
  dataset: "longmemeval-s" | "locomo" | "dmr" | "coding-continuity";
  track: "G" | "H";
  runs: number;               // 3, per D5
  scores: number[];           // one per run
  mean: number;
  variance: number;
  readerModel: string;        // D9 — the fixed answer-composer, same for all systems in this run
  readerPromptRef: string;    // D9 — fixed/published reader prompt id
  judgeModel: string;
  judgePromptRef: string;     // e.g. "brv-bench/justify.txt@<commit>" or "iranti-original/coding-continuity-v1"
  timestamp: string;
}
```

**Extended (additive, backward-compatible): `Corpus`** in `src/harness/types.ts` gains an optional `sessionBoundary?: number` field per docs/research §d ("a new field on the existing corpus shape, not a new file format") — used only by the coding-continuity dataset loader in `bench/competitive/datasets/coding-continuity.ts`; existing 4 personas and `pnpm bench` are unaffected (field is optional, unset everywhere it doesn't apply).

**No changes** to `src/mcp/*`, `src/library/*`, or any production iranti-next code path. This phase is bench-tree-only.

## 7. Acceptance criteria

- [ ] This PRD accepted before any adapter/runner code is written.
- [ ] `Adapter` interface (§6) implemented and exported from `bench/competitive/types.ts`; a type-check-only test confirms all Milestone-1/2 adapters satisfy it.
- [ ] MCP stdio client ported from `mem2-for-ai-by-ai/bench/mcpclient.mjs` into `bench/competitive/mcp-client.ts`, used by iranti-next, iranti-old, and ai-mem adapters (D2) — no second stdio client written.
- [ ] **Milestone 1 shippable independently:** iranti-next (heuristic / local / frontier) + iranti-old, on LongMemEval-S (full 500) + coding-continuity, both tracks, N=3 each — produces `bench/competitive/results/milestone-1-*.json` with real (non-placeholder) scores. Zero external installs required to reach this checkbox. (iranti-old adapter wraps the LIVE global v0.4.1 `iranti mcp` — Postgres already up on :5432; iranti-next adapters spawn `tsx src/mcp/server.ts` with the three `IRANTI_EXTRACTOR` settings.)
- [ ] **Milestone 2 shippable independently, resumable from Milestone 1's committed state:** + ai-mem adapter, same datasets/tracks — first result row where iranti is compared to a non-iranti system through the shared harness. Still zero paid accounts.
- [ ] Track G and Track H configs verified to differ ONLY in the `RunConfig` object and judge-prompt-variant string passed to identical adapter/judge code (D3) — spot-checked by diffing the two invocation paths. Track G uses ONE `topK` value across all systems, not a per-system sweep (D3a).
- [ ] Shared reader stage (D9): every system's graded answer is produced by the same `composeAnswer(question, retrieved, ReaderConfig)` from that system's `retrieved` context — no adapter's `nativeAnswer` reaches the judge. Spot-checked by confirming the judge input for two different systems came from the identical reader model + prompt.
- [ ] Judge determinism/variance: every Milestone-1/2 cell has N=3 scores and a reported variance, not a bare mean (D5).
- [ ] Coding-continuity results always render under a distinctly labeled column/section, never merged with or described as a LongMemEval/LoCoMo number (D7) — spot-checked in the results JSON and any generated table.
- [ ] LoCoMo judge prompt is the reused `brv-bench` prompt (or LongMemEval-S's own published prompt, model swapped to claude-sonnet-5) with the source commit/version recorded in `judgePromptRef` — not an iranti-authored paraphrase (D4).
- [ ] **Runner is question-level resumable (NF chose full-500 LongMemEval-S — an interrupted multi-hour run must NOT re-spend frontier calls already made):** per-question results are written incrementally to `results/`, and a re-invoked run skips any (system × dataset × track × run × question) cell already present. Verified by killing a run mid-cell and confirming the resume re-uses prior per-question rows.
- [ ] `bench/.env` (temp Anthropic key) never appears in any committed file, log line, or results JSON — spot-checked via `git grep` before each milestone's commit.
- [ ] `bench/competitive/README.md` documents exact install/run commands for every adapter reached so far, sufficient for a fresh session to reproduce Milestone 1 and 2 from a clean checkout.
- [ ] Full existing suite (`pnpm bench`, `pnpm bench:messy`, `pnpm bench:semantic`, `tsc`, lint) stays green — this phase adds a sibling tree, it does not touch `src/harness/` scoring behavior for the 4 existing personas.

## 8. Deltas from the master PRD

None to the master PRD's core sections. This phase extends the Layer 0b measurement harness's *types* (additive `sessionBoundary` field) but does not alter its scoring semantics, its 4 existing personas, or `pnpm bench`'s determinism guarantee. It is a new, separate benchmarking surface (`bench/competitive/`) alongside the existing one (`src/harness/`), per the plan of record's own framing (S2–S4 are explicitly a superset of, not a replacement for, S0's internal instrument).

## 9. Risks & open questions

- **SCOUT VERIFICATION (2026-07-04) — three findings that reshaped the plan (all primary-source):**
  - **DMR is not a downloadable dataset — dropped from M1.** MemGPT (arXiv:2310.08560) never packaged DMR as a ready eval set; only raw MSC-Self-Instruct data + a paper method exist (GitHub issue cpacker/MemGPT#103 confirms the harness was never released). Any DMR run is a *reconstruction* — and a reconstruction is not comparable to published DMR numbers, which defeats DMR's only purpose here (comparability). Since our own §5 calls DMR a smoke test, it's dropped from M1 rather than reconstructed. May return later ONLY if clearly labeled "iranti reconstruction, not canonical DMR."
  - **brv-bench is real and reusable, but `--context-tree-source` is NOT a system-swap flag.** `github.com/campfirein/brv-bench` (MIT, pip-installable) genuinely ships reusable LoCoMo judge + justifier prompts (`brv_bench/metrics/_judge/prompts.py`, `brv_bench/datasets/locomo.py`). BUT `--context-tree-source` is a data-path flag for isolated-mode context trees — plugging iranti in requires writing a new `RetrievalAdapter` subclass (`setup/query/reset/teardown`) and bypassing ByteRover's own `curate` ingestion step. M2's LoCoMo cost must include that adapter, not assume a flag. (Corrects the research doc's claim.)
  - **LoCoMo's native scoring is F1/exact-match, not an LLM judge — which is a gift for dual-track.** The `snap-research/locomo` repo scores with F1 (`task_eval/evaluation.py`); the Curate→Retrieve→Justify→Judge LLM-judge pipeline is a *vendor convention* (ByteRover/Hindsight), not the paper's method. So LoCoMo maps cleanly onto G/H: **Track G = the vendor-convention LLM judge (brv-bench, comparable to leaderboards); Track H = the original repo's F1/EM (the paper's real methodology).** The per-system G−H gap on LoCoMo then literally quantifies lenient-judge-vs-F1 inflation. Fold into M2. NOTE: LoCoMo dataset is **CC BY-NC 4.0 (non-commercial)** — flag for iranti's commercial angle before publishing LoCoMo numbers.
- **LoCoMo protocol fidelity is the #1 risk, named explicitly per NF's brief.** If `brv-bench`'s judge/justifier prompts can't be cleanly reused (license, availability, or the flag not working as documented), the fallback is NOT to approximate LoCoMo with an iranti-authored judge and still call it "LoCoMo" — per docs/research's own framing, that is exactly the move the field's disputed vendor numbers made. The fallback is to either (a) find and verify a second real reuse path before running, or (b) skip LoCoMo for that milestone and say so plainly in the results ("LoCoMo: not run this milestone, protocol-fidelity gate unresolved") rather than publish a look-alike number under LoCoMo's name. This gate is a milestone acceptance criterion in spirit even though it isn't a checkbox above (it's a go/no-go on whether LoCoMo runs *at all* in a given milestone, not a property of a run that already happened).
- **`brv-bench` availability unverified in this PRD.** docs/research cites it as "open-sourced" with a GitHub link, but nobody has cloned/run it yet as of this PRD. First concrete task inside Milestone 1 or 2 (whichever first needs LoCoMo) is confirming it actually works as described — if it doesn't, see the fallback above.
- **MemBench-style "scoring formula not confirmed from source" risk applies by analogy to any dataset this phase touches.** Before wiring a dataset loader, confirm the scoring protocol from the primary source (paper PDF or repo), not a secondary summary — the research doc already flags MemBench and BEAM as unconfirmed-from-secondary-sources examples; the same discipline applies to LongMemEval-S and LoCoMo even though those two are better-established, since "well-established" and "actually read the primary source before coding" are not the same claim.
- **N=3 may be too few if variance is high.** D5 picks 3 as a deliberate middle point, not a proven-sufficient number. If Milestone 1's own variance numbers come back wide (e.g., spread larger than the gap between systems), that is itself a finding — revisit N upward for later milestones rather than silently trusting a noisy mean.
- **Judge/reader model confound vs. published numbers (named limitation, not a bug).** Track G aims to be *comparable to* published leaderboard numbers — but most of those were produced with a GPT-4o judge/reader, and this phase uses `claude-sonnet-5` because that is the only frontier key on hand (the temp Anthropic key; NF explicitly does not want users to bring an OpenAI key, and the committed `iranti-benchmarking` OpenAI key is being revoked). Reusing the published *prompt* while swapping the *model* keeps the protocol identical but introduces a model confound: our Track-G number is "same-protocol, different-judge/reader-model," so it is comparable-in-method to published numbers, not a drop-in replacement for them. This is disclosed on every Track-G table, and it is *internally* fair (every system in our run gets the identical Claude judge+reader), which is what the head-to-head actually needs. Revisit only if a GPT-4o key becomes available and true cross-publication comparability is worth the spend.
- **Shodh's identity is still unconfirmed** (docs/research: "this match is not confirmed to be the same 'Shodh' the mandate refers to"). Out of scope for this phase's milestones, but flagged so a later milestone doesn't wire an adapter against the wrong product without re-checking.
- **Zep/ByteRover free-tier availability unverified.** Milestone 4+ is gated on this per the plan's S3c; do not build those adapters speculatively before the gate clears (mirrors the plan's guardrail: "External-system installs are the expensive part — each gets confirmed + scoped before launch, not spawned speculatively").
- **Obsidian's apples-to-oranges boundary (docs/research §b, "The Obsidian apples-to-oranges boundary, made explicit") must be preserved in whatever labels this phase's results table eventually uses** — deferred to S4, but the `ResultRow.system` value for Obsidian, whenever that adapter lands, should carry a suffix distinguishing "retrieval-only slice" from a full comparison row, so a later synthesis step doesn't accidentally collapse the distinction.
- **RESOLVED (NF, 2026-07-04) — LoCoMo scope:** LoCoMo *wiring* stays in Milestone 1 as a build target; its first *scored run* is **deferred to Milestone 2**, gated on `brv-bench` being confirmed reachable. Milestone 1's acceptance bar is LongMemEval-S + DMR + coding-continuity only. (The PRD's §4 assumption — defer the run, not the wiring — is confirmed.)
- **RESOLVED (NF, 2026-07-04) — judge budget:** run the **full LongMemEval-S (all ~500 questions)** from Milestone 1, not a subset. NF explicitly chose completeness over cost here ("willing to wait for genuinely fair results"), making Milestone 1 the deliberately-expensive, thorough milestone. The `claude-sonnet-5` judge+reader is the accepted conscious exception to the default-cheaper preference, justified by its fairness role. Consequence to honor at build time: the runner must be **checkpoint/resumable at the question level** (write each cell's per-question results incrementally to `results/`), so a multi-hour Milestone-1 run that is interrupted resumes without re-spending the frontier calls already made — this is now a build requirement, not optional.
- **RESOLVED (Claude, 2026-07-04) — judge-model confound:** accept the `claude-sonnet-5`-vs-published-GPT-4o caveat (documented above) rather than sourcing a GPT-4o key — NF does not want bring-your-own-keys and the only committed OpenAI key is being revoked. Revisit only if NF later wants literal published-leaderboard comparability.

## 10. Verification

Type-check that every Milestone-1/2 adapter satisfies `Adapter` (§6); unit tests on the ported MCP client (reuse `mem2-for-ai-by-ai`'s own test coverage as a starting point if any exists, otherwise smoke-test spawn/request/response against a real iranti-next MCP server); integration run of Milestone 1 end-to-end (all 4 iranti configs × [LongMemEval-S full-500 + coding-continuity] × 2 tracks × N=3, real scores, no placeholders) as the primary acceptance evidence; integration run of Milestone 2 adding ai-mem as the cross-system proof point; `git grep` for the temp key string pattern across the diff before each milestone's commit; full existing suite (`pnpm bench`, `bench:messy`, `bench:semantic`, `tsc`, lint) green throughout, confirming this phase is additive.

## Changelog
- 2026-07-04 — proposed
- 2026-07-04 — review pass (Claude): added D9 shared reader/answer-generation stage (fairness-critical — was missing; each adapter would otherwise be scored on its own answer-writing, not its memory); corrected Track G to a uniform fixed-generous config, not a per-system sweep (D3a); recorded reader model/prompt in `ResultRow`; documented the claude-sonnet-5-vs-published-GPT-4o judge/reader confound as a named limitation. Three decisions escalated to NF (LoCoMo in M1 vs M2; judge-spend ceiling; judge-model confound tolerance).
- 2026-07-04 — build (runner) — two cost/fidelity revisions, recorded here per honest-instrument discipline: (a) **ingest-once per case** — a LongMemEval haystack is ingested once per (system, case); Track G/H re-query the same store at different topK, so ingestion (the frontier config's expensive part) never multiplies by tracks/runs. (b) **N=1 under temperature-0 revises D5** — LongMemEval's published reader+judge run at temp=0 (deterministic), so N=3 would be 3× the spend for byte-identical results and is *less* reproducible than a fixed single run; RUNS_PER_CELL defaults to 1 (loop still supports >1 for a future stochastic dataset). M1 Track G/H separation is therefore topK-driven (50 vs 5) over the same published judge; the lenient-vs-strict judge lever becomes load-bearing for LoCoMo M2 (where H = the native F1 scorer).
- 2026-07-04 — scout verification pass (3 read-only scouts, primary sources): LongMemEval-S fully pinned (HF `xiaowu0162/longmemeval-cleaned`, MIT, verbatim reader+judge prompts). **DMR dropped from M1** (never packaged; reconstruction ≠ comparable). **LoCoMo/brv-bench corrections** (custom `RetrievalAdapter` needed, not a `--context-tree-source` flag; native scoring is F1 → clean G/H mapping; CC BY-NC 4.0). Adapter surfaces pinned: iranti-old = LIVE global v0.4.1 `iranti mcp` (Postgres :5432 up), iranti-next = `tsx src/mcp/server.ts` (ingest is an `iranti_attend` side-effect), ai-mem client portable. Separately confirmed: **the iranti MCP connected this session is the OLD v0.4.1, not iranti-next** (validates NF's repeated suspicion; benchmark will be the first real iranti-next MCP exercise here).
