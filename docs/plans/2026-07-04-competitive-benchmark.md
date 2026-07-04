# Competitive Benchmark Program — Plan of Record (RESUME SUBSTRATE)

**Date:** 2026-07-04 · **Status:** ✅ **GREENLIT by NF** (external fan-out approved). Priorities: **genuinely fair results over speed** (NF: "willing to wait a long time"); **must survive token limits** (this file + iranti checkpoints are how a fresh session resumes).

**This file is the resume substrate.** A cold session reads it top-to-bottom, checks the Stage Ledger (below), and continues from the first unchecked box. Durable progress is also checkpointed in iranti (`project/iranti`, keys `competitive_bench_*`).

**Mandate (NF, 2026-07-04):** benchmark old-iranti, new-iranti (no-LLM / API-key / Ollama), Obsidian, ByteRover, Shodh, Mem0-or-Zep, and ai-mem; borrow methods from ByteRover's published work + deep-research other AI-memory benchmark methods; test with completely-novel vocabulary and messy conversation. **Obsidian = the note app** (benchmark against it directly — it publishes no papers; methods come from the deep-research pass + ByteRover/LoCoMo).

## Stage Ledger (resume from first unchecked)

- [x] S0. Internal instrument ✅ (commit 4235f38c, verified+pushed): value-recall scorer + messy + novel-vocab corpus + `bench:messy`. **Result on messy corpus (value-recall): R0 heuristic 4.3% → R1 local qwen2.5:7b 17.4% → R2 frontier claude-sonnet-5 47.8%** — the LLM's value is now visible (identity-recall stayed blind to R1 at 0%). Caveat: R2 also fabricated most (3/6 probes vs R1's 0/6) — frontier extracts more AND hallucinates more, so it needs the grounding gate (AX-4); local qwen was the most abstention-honest. Small corpus (23 golds) — directional, not definitive. Builder also fixed 2 shared extract/index.ts bugs (IRANTI_LLM_TIMEOUT_MS override; temp-omit for anthropic.com hosts), both default-preserving (default bench byte-identical, verified).
- [x] S1. Deep-research methods catalogue ✅ → `docs/research/2026-07-04-memory-benchmark-methods.md` (committed e2d9b1ad). Fair suite locked: LongMemEval-S + LoCoMo (ByteRover judge prompts) + DMR + iranti coding-continuity (separate axis). See `project/iranti/research/benchmark-methods/s1_deep_research_findings`.
- [~] S2. The fair competitive harness — PRD `bench-1-fair-competitive-harness.md` **ACCEPTED + reviewed + scoped** (commit 138963fa; review folded in D9 shared reader stage, D3a uniform Track G, question-level resumability). `bench/competitive/types.ts` built. **3 scouts done (primary-source verified)** — see `project/iranti/research/{longmemeval-s-wiring,dmr-locomo-brvbench,m1-adapter-substrate}`. NF scope: full LongMemEval-S(500) from M1; LoCoMo run→M2; accept sonnet-5 judge-model confound. **DMR DROPPED from M1** (never packaged → reconstruction ≠ comparable). M1 datasets = LongMemEval-S + coding-continuity. brv-bench real but needs a custom RetrievalAdapter (not a flag); LoCoMo native scoring=F1 → clean G/H (G=vendor-judge, H=F1), CC-BY-NC-4.0. **Confirmed: session's iranti MCP is OLD v0.4.1, not iranti-next** (validates NF's suspicion). Adapter surfaces pinned (ai-mem client, iranti-old=live `iranti mcp`/Postgres:5432, iranti-next=`tsx src/mcp/server.ts`). NEXT: spawn cheap builders for mcp-client+adapters+LongMemEval loader+coding-continuity, then reader+judge+resumable runner. Dual-track G/H lives here.
- [ ] S3. External adapters, ONE at a time, cheapest-first, each on the SAME inputs/judge (per the S2 PRD's adapter interface):
  - [~] S3a. ai-mem = `mem2-for-ai-by-ai` (local, MCP+CLI, NO accounts — the cheapest first external target; already has a reusable MCP client). PRIOR RESULT to re-test fairly: ai-mem beat OLD iranti-0.4.1 90% vs 71% hit@1 on ai-mem's own naive-substring bench (caveats: old iranti + feature-hashed embeddings + ai-mem home corpus — the fair harness re-tests current iranti properly). `iranti-benchmarking` = active program w/ working Mem0/Shodh/Graphiti adapters (Apr 2026) — adapt its plumbing, not its naive graders. FLAG: committed plaintext OpenAI key in `iranti-benchmarking/.env` — NF revoke.
  - [ ] S3b. Mem0 OSS (local SDK)
  - [ ] S3c. Zep and/or ByteRover (keyed/cloud — verify free tier before committing effort)
  - [ ] S3d. Shodh (locate its interface first — unknown)
  - [ ] S3e. Obsidian app (shared vault; retrieval precision/recall@k — apples-to-oranges boundary documented per deep-research §5)
- [ ] S4. Synthesis: one comparison table across all systems × the fair suite, with the coding-memory axis as iranti's home-field differentiator → `docs/reviews/<date>-competitive-benchmark-results.md`.

**Fairness rules (non-negotiable, NF's "genuinely fair"):** same corpus + same judge + same inputs for every system; self-reported vendor numbers flagged as such and re-run locally where possible; iranti gets NO home-field advantage on the shared conversational tasks (its coding-memory edge is shown on a SEPARATE, clearly-labeled axis, not by tilting the shared tasks); every method's apples-to-apples-ability recorded from the deep-research catalogue.

**DUAL-TRACK scoring (NF, 2026-07-04) — run BOTH, report side by side:**
- **Track G ("as the industry games it"):** replicate the score-inflating setups the S1 research caught in the wild — top_k tuned high (the MemPalace 50-vs-32 trick), best-of-N / multi-run-report-the-max (Zep's single-lucky-run), favorable/self-authored judge prompts, the generous scoring-target the methodology paper showed flips 83–94% of rankings. This makes iranti's number *comparable to the published leaderboard claims* (else we look artificially low next to inflated numbers). EVERY system gets the same generous treatment — the point is comparability, not our own inflation.
- **Track H ("the right way"):** single run, fixed pre-registered config, strict/decision-driving scoring (MemoryArena-style: memory must drive a correct decision, not just surface a snippet), one neutral judge prompt applied identically. This is the number we actually trust and publish as iranti's honest claim.
- The gap between Track G and Track H, PER SYSTEM, is itself a headline result: it quantifies how much each competitor's public number is inflated. iranti's own G–H gap should be small (that's the honest-instrument thesis made visible); a competitor's large G–H gap is the story.

**Resume/continuity mechanics:** each S3 adapter is independently resumable (its own PRD + branch note); external installs live under `bench/external/<system>/` with a README capturing exact install/run commands so a fresh session reproduces them; the temp Anthropic key stays in gitignored `bench/.env` (REVOKE when done — flagged every turn).

---

## 1. The systems (9) and how each is actually reachable

| System | What it is | Access path | Effort |
|---|---|---|---|
| **iranti (old, v0)** | the Prisma-era production build | MCP server already wired this session | trivial |
| **iranti-next: heuristic** | R0 — regex only | `IRANTI_EXTRACTOR=heuristic` | trivial (done) |
| **iranti-next: local LLM** | R1 — + Ollama qwen2.5:7b | `IRANTI_EXTRACTOR=local` | trivial (done) |
| **iranti-next: frontier** | R2 — + Anthropic via temp key | `IRANTI_EXTRACTOR=local` + `bench/.env` | trivial (running now) |
| **Mem0 or Zep** | the market-leading memory SDKs; both report on LoCoMo/LongMemEval | pip/npm SDK + their API (Zep cloud key / Mem0 OSS local) | medium — SDK adapter |
| **ByteRover** | agent-native/coding memory; scores 92–96% on LoCoMo/LongMemEval | product API (likely paid/keyed) — verify free tier | medium-high — may need account |
| **Shodh** | (unverified — need to locate its interface) | TBD — research first | unknown |
| **Obsidian** | note app; **not** a paper-publishing memory system — see §4 clarification | local vault + its search/graph or a community MCP | medium + ambiguity |
| **ai-mem** | in the projects folder: candidates `mem2-for-ai-by-ai`, `memory-for-ai-by-ai` | local repo — inspect + run in-place | low-medium (it's ours-adjacent) |

Also on disk and relevant: `iranti-benchmarking` (a pre-existing benchmarking project — inspect before rebuilding), `iranti-research-paper`.

## 2. The testing methods (from the published work)

- **LoCoMo** (Long-term Conversation Memory, ACL 2024 — UNC/USC/Snap): the field standard. Pipeline **Curate → Retrieve → Justify → Judge** (LLM-as-judge with published judge prompts; ByteRover reuses Hindsight's public prompts for comparability). This is the apples-to-apples number every competitor reports.
- **LongMemEval** (500 Qs, 6 categories): single-session user/assistant/preference recall, **knowledge-update tracking**, **temporal reasoning**, multi-session aggregation, and **abstention**. The abstention category IS iranti's no-answer honesty (falsePositiveRate) — direct alignment, and a category most competitors are weak on.
- **iranti's own golden-corpus harness**: extraction recall/precision, retrieval hit/confirmation, fabricationRate, rules — plus the new **value-recall** metric (key-agnostic credit; running now) so LLM extraction is finally creditable.
- **Novel-vocabulary probes** (NF ask): invented tool/product/person names + rare jargon never in training data — separates genuine extraction/retrieval from model memorization. Building now in the messy corpus.
- **Messy-conversation corpus** (NF ask): rambling, implicit, mid-sentence-correction real-transcript style where regex gets ~0 and the LLM's value shows. Building now.
- **The coding-memory gap** (research finding worth exploiting): the literature notes *no* standard benchmark covers coding-agent memory — every one is conversational. iranti is coding-agent memory. A coding-task-continuity test (does memory carry a decision across two "sessions" of a coding task?) would be a differentiated, publishable axis and is where ai-mem lives.

## 3. Sequencing (each slice is a gate)

1. **Instrument (running now, no external deps):** value-recall metric + messy corpus + novel-vocab corpus + R0/R1/R2 on messy. → first honest local-vs-frontier signal. *This is the prerequisite for every comparison below — a benchmark whose own instrument can't credit an LLM is worthless against LLM-backed competitors.*
2. **LoCoMo + LongMemEval harness for iranti** (medium; downloads the public datasets + judge prompts): gets iranti a number on the *same* scale competitors publish. No competitor installs yet — first, can iranti even be scored on their turf.
3. **External adapters, ONE system at a time, cheapest-first:** ai-mem (local, ours-adjacent) → Mem0-OSS (local) → Zep/ByteRover (keyed/cloud, verify free tier) → Obsidian (after §4 clarified) → Shodh (after its interface is found). Each is its own small PRD + adapter + run; **this is the fan-out that needs your go.**
4. **Synthesis:** one comparison table across all systems × all methods, with the coding-memory axis as iranti's home-field differentiator.

## 4. One thing to clarify before §3

**"Obsidian's published papers"** — Obsidian is a note-taking app; it doesn't publish memory-benchmark papers. Three possibilities: (a) you mean Obsidian-the-app as a *system* to benchmark against (compare iranti retrieval vs Obsidian search/graph on a shared vault) and the *methods* come only from ByteRover; (b) there's a specific "Obsidian" memory paper/system I haven't located; (c) a different name got crossed. LoCoMo + LongMemEval + ByteRover's method are real and found — I'll build on those; tell me which Obsidian you meant and I'll slot it in.

## 5. Guardrails

- **The temp Anthropic key** lives only in gitignored `bench/.env`; never committed, logged, or written to memory; **revoke it when the frontier runs are done** (flagged every turn until you confirm revocation).
- External-system installs are the expensive part — each gets confirmed + scoped before launch, not spawned speculatively.
- Every competitor comparison uses the SAME corpus + SAME judge to stay apples-to-apples (the whole point of reusing published prompts).

## Sources
- [ByteRover LoCoMo benchmark](https://www.byterover.dev/blog/benchmark-ai-agent-memory) · [ByteRover arXiv](https://arxiv.org/html/2604.01599v1) · [LongMemEval](https://www.emergentmind.com/topics/longmemeval) · [Mem0 state-of-memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
