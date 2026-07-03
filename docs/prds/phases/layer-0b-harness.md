# PRD: Layer 0b — Minimal Measurement Harness

**Status:** accepted
**Phase:** Layer 0b (YC foundation track) · **Date:** 2026-07-03 · **Author:** NF + Claude
**Related:** master PRD (memory-quality claims), Layer 0 PRD (`layer-0-foundation.md`, sibling — embedded PGlite default engine this harness runs against), backlog: measurement/benchmark track. Downstream: entity resolution, rules enforcement, checkpoints — every subsequent feature is judged against this gate. Seed of the future public benchmark.

---

## 1. Summary

Build a golden-corpus measurement harness that turns "iranti's memory got better/worse" from a vibe into a diffable number. It ingests four fixed, versioned developer-persona transcripts through the real `attend`/`write` paths on a fresh embedded PGlite store, scores extraction and retrieval against gold labels, and prints a delta against a checked-in baseline. It runs deterministically (heuristic extractor only, zero LLM calls) so it is safe to run in CI and re-run byte-for-byte.

## 2. Problem & motivation

iranti-core has no way to answer "did this change help or hurt memory quality" except reading code and trusting intuition. Every future feature on the roadmap — entity resolution (aliases like "the textbook"), rules enforcement, checkpoints — needs a before/after number or its impact is unverifiable and un-arguable in review. Without this harness, quality claims in PRDs and commit messages are unfalsifiable, and there's real risk of the classic memory-system failure mode: optimizing for one hand-picked chat transcript (overfitting to a single user's style) while regressing everyone else silently.

## 3. Goals & non-goals

**Goals**
- A deterministic default run (`pnpm bench`) that measures extraction recall/precision, retrieval hit-rate, confirmation rate, and no-answer false-positive rate against a fixed multi-persona corpus, with zero LLM calls.
- A baseline file that the runner diffs against, so "improved/regressed" is a printed number, not an opinion.
- A corpus that actively guards against overfitting to one developer's voice: at least 3 distinct technical personas + 1 messy conversationalist, none modeled on the author's own style.
- Run-to-run byte-identical output in heuristic mode (the determinism thesis applied to measurement itself).
- A place for a future `--extractor=local` (Ollama) mode, explicitly NOT part of the default CI gate.

**Non-goals**
- Making the numbers good. This harness measures Layer 0/2b's current, largely non-semantic retrieval; low recall/precision on alias and correction cases is expected and intentional — that gap is the point (it's what entity resolution will later close, measured as a delta).
- A public-facing benchmark site/leaderboard (this is the seed corpus + runner only).
- Any change to `attend()`/`write()`/extractor internals. This PRD builds a measurement instrument, not a memory-quality fix.
- Vector/embedding-based retrieval scoring (Layer 0 already scoped local retrieval to lexical + graph only; this harness measures what exists).

## 4. Scope

**In**
- `src/harness/` module: corpus loader, ingest runner, scorer, baseline differ, console reporter.
- `bench/corpus/*.json`: 4 persona transcripts (backend-API dev, frontend dev, data/ML person, messy conversationalist), ~10–15 messages each, with gold-labeled extracted facts and probe queries.
- `bench/baseline.json`: generated from the current main-state (Layer 0a) run, checked in.
- `src/harness/harness.test.ts`: the vitest spec that executes the runner (dodges the Node `.js`-specifier strip-types limitation the same way `it-runs.test.ts` does), writes `bench/latest.json`, prints a console table, and asserts ONLY the determinism check.
- `pnpm bench` script = `vitest run` of that one spec.

**Out (deferred, with owner)**
- `--extractor=local` Ollama wiring → later, once local-LLM extraction quality is itself being iterated on. The corpus/scorer format already supports it (extractor is a parameter to ingest, not hardcoded), so no rework is needed to add it.
- Public benchmark packaging/site → later, post-traction.
- CI wiring (actually gating merges on this) → whenever the team sets up CI; out of scope for this PRD, which only has to make the gate runnable.

## 5. Design decisions & rationale

- **D1 — Deterministic-only default.** The default `pnpm bench` run forces `IRANTI_EXTRACTOR=heuristic` and uses only keyword+graph retrieval (attend's existing default path — no LLM is wired into attend regardless). Why: a measurement instrument that isn't reproducible is worse than no instrument — it produces numbers nobody can trust or diff. *Rejected:* defaulting to `local` mode, which would make CI runs depend on a live Ollama endpoint and produce non-reproducible numbers (LLM output isn't guaranteed byte-stable even at temperature 0 across model/endpoint versions).
- **D2 — Corpus authored from scratch, four distinct voices, not derived from any one user's real chats.** The explicit risk named in the mandate is overfitting the harness (and, later, the memory system) to how one person writes. Personas are deliberately differentiated: terse/technical (backend), casual/UI-focused (frontend), jargon-dense (data/ML), and unstructured/tangential (messy conversationalist). *Rejected:* one large corpus scored in aggregate only — aggregate-only would hide a regression that helps one persona while hurting another.
- **D3 — Four metrics + one integrity check, not one composite score.**
  1. **Extraction recall/precision** — match gold facts on normalized `(entityType/entityId, key)`; value match scored separately (leniently — substring/normalized-equality, not exact byte match) since phrasing varies.
  2. **Retrieval hit-rate** — after ingesting a transcript, run each probe query through `attend()` and check whether the expected fact appears anywhere in `facts[]` (report *rank*, i.e. position in the returned list, not just boolean hit). Computed over positive probes only.
  3. **Confirmation rate** — the named product KPI ("confirm, don't discover"): fraction of positive probes where the gold fact is in the TOP-returned set (rank 1, i.e. the first fact) — the standard a user could act on without scanning. This is stricter than hit-rate by design; the gap between the two numbers IS the "how much scanning is required" measurement.
  4. **False-positive rate on negative probes** — each persona carries 2 no-answer ("negative") probes: plausible-sounding questions whose correct answer is NOT in the corpus. A false positive = any fact returned for such a probe (no relevance threshold exists to fall below today, so this is the honest, harsh definition). No-answer queries measure whether retrieval knows when it doesn't know — the failure mode that produced 5/5 confident false positives in the external benchmark of iranti 0.4.1's trick queries. Expected to score badly today; exists so a future no-answer/thresholding feature has a day-one measurable target. Excluded from hit-rate/confirmation-rate denominators (they would otherwise be guaranteed misses polluting a different measurement).
  5. **Determinism check** — two consecutive runs produce byte-identical JSON (timestamps excluded from the compared payload). This one is asserted; the other four are reported, not gated — see D5.
  *Rejected:* a single blended score — it would hide exactly the recall-vs-precision and hit-rate-vs-confirmation-rate tradeoffs the harness exists to expose.
- **D4 — Baseline diff, not pass/fail thresholds.** `bench/baseline.json` is checked in; the runner always prints current-vs-baseline per-metric deltas. An `--update-baseline` flag regenerates it. Why: iranti has no real users yet and today's numbers are known to be low (Layer 0/2b has no entity resolution) — a hardcoded quality floor would either be trivially met (useless) or fail the gate on legitimate zero-feature-change commits (noisy). The diff format is what makes "improved/regressed" concrete without pretending we know what "good" is yet.
- **D5 — The spec asserts nothing about absolute quality, only determinism.** `harness.test.ts` must stay green regardless of how bad recall/precision/confirmation are today — the acceptance bar for this PRD is "the instrument works and is honest," not "memory is good." The ONE hard assertion is run-to-run determinism, because that's a property of the harness itself (a bug in the harness), not of memory quality. This keeps the gate usable in CI immediately, before any quality work has landed.
- **D6 — Runs through vitest, not plain `node`.** Known repo limitation: `node --experimental-strip-types` cannot resolve TS-source `.js`-suffixed relative specifiers the way `tsx`/vitest's transform can (see `db:migrate`'s workaround and `it-runs.test.ts`'s header comment). Rather than fight that, the harness runs as a vitest spec, exactly like the other whole-system smoke tests. `pnpm bench` is `vitest run src/harness/harness.test.ts` (or an equivalent narrow pattern), not a new runtime.
- **D7 — One fresh PGlite store per persona, in-process, via `vi.resetModules()`.** `attend()`/`write()` depend on module-level singletons (`src/mcp/context.ts`'s `current`/`pending` handshake state, and `src/db/connection.ts`'s top-level-await'd `db`/`pool`). Running four personas against one shared store would let facts and sessions bleed across personas and invalidate isolation; running four *separate vitest files* would work but loses one shared, easily-diffed `latest.json`. Precedent: `persistence.test.ts` already does exactly this reset-and-reimport dance for a single restart cycle. The harness generalizes it to a loop over N personas, each getting its own `mkdtempSync` data dir, its own `IRANTI_DATA_DIR`, a `vi.resetModules()` between personas, and a fresh dynamic `import()` of `attend.js`/`write.js`/`connection.js`. *Rejected:* one shared store with a `project`/`tenantId` dimension per persona — Layer 0's per-project scoping (D6 of that PRD) is a sibling deliverable, not yet load-bearing everywhere (e.g. graph edges are not project-scoped today), so relying on it here would couple this PRD to Layer 0 internals that may still shift.
- **D8 — Gold labels live beside the transcript, in the same JSON file.** One file per persona (`bench/corpus/<persona>.json`) containing `messages` (ordered, each with role/text and which entity hint(s) apply), `goldFacts` (expected entity+key+value triples), and `probes` (query text + entity hint + expected fact key(s)). Why: keeps a persona's transcript and its expected outcomes co-versioned — editing one without the other is a visible diff in one file, not a silent drift between two.
- **D9 — Alias/correction cases are included and expected to score low today.** Each persona's transcript includes ≥2 correction cases (a fact stated, then explicitly corrected) and ≥2 alias-style references (an entity referred to by a nickname the system cannot yet resolve, e.g. "the textbook" instead of a named repo). These are gold-labeled with the *intended* resolved fact, so today's score legitimately undercounts them — that gap is exactly what entity resolution is supposed to close, and the harness will show the delta when it ships.

## 6. Schema / API changes

None. No changes to `facts`/`entities`/`graph` schema, no changes to `attend()`/`write()`/extractor signatures. This PRD is additive-only: new files under `src/harness/`, `bench/`, and one new `package.json` script.

## 7. Acceptance criteria

- [ ] `docs/prds/phases/layer-0b-harness.md` (this file) exists, accepted.
- [ ] `bench/corpus/*.json` contains 4 persona transcripts (backend-API dev, frontend dev, data/ML person, messy conversationalist), each ~10–15 messages, each with ≥2 correction cases and ≥2 alias references, each with gold facts and probe queries.
- [ ] `src/harness/` implements: corpus loader, per-persona fresh-PGlite ingest (through real `attend`/`write`), scorer (recall/precision/hit-rate/confirmation-rate/false-positive-rate), baseline differ, console reporter.
- [ ] Each persona corpus includes ≥2 negative (no-answer) probes, and the scorer reports `falsePositiveRate` from them (D3.4).
- [ ] `bench/baseline.json` checked in, generated from the current (Layer 0a) main state.
- [ ] `pnpm bench` runs green end-to-end, writes `bench/latest.json`, prints a per-persona + overall console table with baseline deltas.
- [ ] Determinism: running `pnpm bench` twice produces identical `bench/latest.json` content modulo timestamps (asserted inside `harness.test.ts`, not just manually observed).
- [ ] `pnpm typecheck` and `pnpm lint` exit 0.
- [ ] Existing suites (`it-runs`, `persistence`, `keys`, and the rest) remain green and untouched.

## 8. Deltas from the master PRD

None. This is a new, additive measurement capability; it does not change any documented user-facing behavior of `attend`/`write`.

## 9. Risks & open questions

- **Vitest module caching across personas.** `vi.resetModules()` resets the module registry, but any library that stashes state outside the ES module graph (e.g. a Node-level global) would survive a reset. Reviewed: `context.ts`'s `current`/`pending` and `connection.ts`'s `db`/`pool` are plain module-scope `let` bindings, which `vi.resetModules()` does reset correctly (same mechanism `persistence.test.ts` already relies on for its single restart cycle) — no known globals escape this.
- **PGlite boot cost × 4 personas × 2 runs (determinism check) = 8 fresh-store boots per `pnpm bench` invocation.** Each boot pays the auto-migrate cost. Acceptable for a harness meant to run in CI occasionally, not on every keystroke; flagged here so a future slow-CI complaint has context. Mitigation if it becomes a problem: cache a pre-migrated PGlite snapshot and copy it per persona instead of re-running migrations from scratch — deferred, not needed at this size.
- **Numbers will be low today, by design (D5, D9).** A reviewer skimming `bench/latest.json` without reading this PRD could mistake "low confirmation rate" for a bug. Documented here and in the harness's own console output so it reads as an honest baseline, not a regression.
- **Corpus realism is subjective.** "Realistic developer conversation" is authored, not sampled from real users (no real user transcripts exist yet to sample from). This is accepted as an intentional stand-in until real usage data exists; the corpus is versioned so it can be revisited.
- **Gold-label value matching is lenient by design** (normalized/substring, not exact) — this avoids penalizing legitimate paraphrase, but means precision numbers have a small amount of scorer-judgment built in. Documented in the scorer's own code comments, not hidden.

## 10. Verification

- **Unit-level (inside harness.test.ts):** corpus loads and validates against its own shape; scorer functions produce expected recall/precision on hand-constructed fixtures (implicitly exercised via the real corpus run, not separately unit-tested — the corpus run IS the test).
- **Integration:** the full ingest → attend → score → baseline-diff → report pipeline runs against 4 fresh PGlite stores in one vitest process.
- **Regression:** `pnpm test` (full existing suite) run after harness code lands, confirming no existing spec was touched or broken.
- **Determinism:** the hard assertion described in D3/D5 — two runs, byte-identical `latest.json` minus timestamps.
- **Manual:** review the printed console table for readability; confirm `bench/baseline.json` reads as a believable snapshot of current (low, honest) quality.

## Changelog
- 2026-07-03 — proposed
- 2026-07-03 — accepted (part of the overnight mandate; Layer 0b sibling to Layer 0)
- 2026-07-03 — addendum before merge: negative-probe class + `falsePositiveRate` metric (D3.4), prompted by the external ai-mem benchmark of iranti 0.4.1 scoring 5/5 confident false positives on no-answer trick queries
- 2026-07-03 — shipped (see commits in `feat/layer0b-harness`; numbers recorded in the harness's own `bench/baseline.json` and PR description)
