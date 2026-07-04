# PRD: Layer 0i — Correction Supersession

**Status:** proposed
**Phase:** Layer 0i (YC foundation track) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** dogfood review `docs/reviews/2026-07-04-dogfood-iranti-next.md` (check 8 PARTIAL, check 10 caveat; fix-list item 4), Layer 0e PRD (project-state rollup), Layer 0f PRD (matched labeling), AX-1 (normalizeKey/tokenizer), master PRD "never hard-delete" + precision-over-recall.

---

## 1. Summary

A conversational correction ("actually, the eval branch name should be dogfood/report-1, not dogfood/report") currently stores a `correction:*` fact **alongside** the stale fact it corrects. Both stay live, both return `matched: true` on the follow-up question, and the project-state rollup's `recentDecisions` surfaces only the stale one — the reorientation brief contains a confidently wrong detail the user already fixed. This phase makes corrections deterministically supersede their targets: when a correction's subject identifies exactly one live fact on the same entity, that fact is archived as superseded (history preserved), and the rollup treats corrections as first-class decisions.

## 2. Problem & motivation

Dogfood evidence (verbatim in the review): after the correction, attend returned

```
correction:the-eval-branch-name        "the eval branch name is dogfood/report-1"   matched: true   (rank 1)
decision:dogfood-report-as-the-eval-…  "dogfood/report as the eval branch name"     matched: true   (rank 2)
```

— two contradictory matched facts, no supersession marker; and `iranti_project_state` reported `recentDecisions: [decision:dogfood-report-as-the-eval-branch-name]` (the stale value) with the correction absent, because the rollup reads only the `decision:` prefix. The explicit same-key write path already supersedes perfectly (fact upsert + archive history, dogfood check 8's PASS half); the gap is purely that extracted corrections land under a *different key* than the fact they correct.

## 3. Goals & non-goals

**Goals**
- A correction that unambiguously identifies one live fact on the same entity archives that fact (reason `superseded_by_correction`), never hard-deleting — history shows the old value.
- The follow-up question returns ONE matched answer (the corrected value).
- `recentDecisions` in the project-state rollup can never surface a value that a newer live correction on the same entity shadows.
- Fully deterministic: same store + same correction → same outcome, no scores, no thresholds tuned by feel (G1).

**Non-goals**
- Cross-entity correction ("actually the OTHER project's breakpoint is…") — corrections apply within the entity the attend turn targeted.
- Semantic/LLM matching of correction subject to fact (G1; the LLM extractor tier may propose corrections later, but resolution stays deterministic).
- Rule correction (rules have no correction pathway; Layer 0d D9 posture unchanged).
- Retroactive cleanup of pre-existing correction/stale pairs in live stores (one dogfood pair exists; migration not warranted — noted §9).

## 4. Scope

**In**
- `src/library/facts.ts` (or a sibling module): `applyCorrectionSupersession(entityType, entityId, correctionKey, tenantId, project): Promise<{ supersededFactId: string | null, candidates: number }>`.
- `src/mcp/tools/attend.ts`: call it in the fire-and-forget extraction chain immediately after a `correction:*` fact is written (both user-authored and host-summary paths).
- `src/library/project-state.ts`: `recentDecisions` reads both `decision:` and `correction:` prefixes, merged by recency (existing limit unchanged).
- Unit + integration tests incl. the dogfood incident replayed verbatim; ambiguity and no-match cases pinned.
- Bench run (expected 0.0pp — corpus has correction messages but no probe scores cross-key supersession today; any movement explained).

**Out (deferred)**
- A `corrected_by` forward-pointer surfaced in attend responses (would need response-shape change; revisit with the token-economy redesign).
- Extending supersession to `iranti_write`-authored facts whose keys merely resemble each other (explicit writes already have same-key upsert as the sanctioned path).

## 5. Design decisions & rationale

- **D1 — Matching rule: subject-token containment, exactly one winner, else do nothing.** Tokenize the correction's subject slug (the text after `correction:`, tokens via the shared `tokenizeMessage` — same tokenizer as facts/rules relevance, AX-1-normalized). A live, non-archived fact on the same entity+project is a *candidate* iff **every** subject token appears in the fact's key token set (key tokens via the same tokenizer), the fact's key is not itself `correction:*` or the checkpoint key. If exactly ONE candidate exists → archive it as superseded. Zero candidates → no-op (the correction stands alone, still retrievable). Two or more → no-op and log; ambiguity must never guess (a wrong auto-archive is strictly worse than a stale duplicate — precision over recall, the same posture as every extractor decision). *Live-incident check:* subject `the-eval-branch-name` → tokens {eval, branch, name} ⊆ key tokens of `decision:dogfood-report-as-the-eval-branch-name` {decision, dogfood, report, as, the, eval, branch, name} → unique candidate → superseded. *Rejected:* overlap thresholds (≥N shared tokens) — threshold-tuning is the fuzzy-matching slippery slope G1 forbids; containment-or-nothing is checkable by eye.
- **D2 — Archive, don't delete; dedicated reason string `superseded_by_correction`.** Rides the existing fact-archive path so `iranti_history` shows the old value with an explanatory reason distinct from `superseded` (same-key overwrite) and `archived_by_user`. No schema change — reason is already free text in the archive row.
- **D3 — Runs in the extraction fire-and-forget chain, sequential after the correction's own writeFact.** Same-turn ordering matters (the correction fact must exist before we act on it); the chain is already sequential-on-purpose for PGlite (Layer 0a). Failure inside supersession is caught and logged, never breaking extraction or the response — consistent with every other post-response side effect.
- **D4 — Rollup: corrections ARE decisions for reorientation purposes.** `findRecentByKeyPrefix` gains the `correction:` prefix alongside `decision:`, merged and recency-limited. *Why:* even with D1 archiving the stale fact, a correction with zero candidates (the fact was never extracted — dogfood check 2's exact scenario) still carries the project's latest truth and must reach the returning developer. *Rejected:* suppression-only (filter shadowed decisions at read time, keep both live) — leaves the two-matched-facts contradiction in attend results, which is the check-8 failure itself; and dual bookkeeping at every read site instead of one write-time archive.
- **D5 — Applies on both user and host-summary extraction paths.** A correction is a correction regardless of author; the AX-9 provenance demotion (confidence 0.70) does not change the archive decision because D1's rule is content-based, not confidence-based. Flagged in §9 as the one place AX-9 and this phase interact.

## 6. Schema / API changes

None to storage (archive `reason` is existing free text). `recentDecisions` may now contain `correction:*` keys — additive semantic change to `iranti_project_state` output, documented for hosts.

## 7. Acceptance criteria

- [ ] This PRD accepted before implementation code.
- [ ] Dogfood incident replay (integration): decision extracted → correction extracted → old fact archived with `superseded_by_correction`, history intact, follow-up attend returns exactly one matched fact (the correction).
- [ ] Ambiguity pinned: two live facts both containing the subject tokens → neither archived, both still live, log line emitted.
- [ ] No-candidate pinned: correction with no matching fact → stored, nothing archived, appears in `recentDecisions`.
- [ ] Never matches checkpoint or other `correction:*` facts; never crosses entity or project (adversarial test).
- [ ] `recentDecisions` shows the corrected value (and not the archived stale one) after supersession; shows the lone correction in the no-candidate case.
- [ ] `pnpm bench` ×2: deterministic; expected 0.0pp, any movement explained line-by-line.
- [ ] Full suite + `tsc` + `lint` green.

## 8. Deltas from the master PRD

None — strengthens "one current value per key" spirit across the extractor's key-synthesis boundary, preserving never-hard-delete.

## 9. Risks & open questions

- **Containment can still mis-target in pathological stores** (a fact key that includes the whole subject phrase but concerns something else, e.g. `issue:the-eval-branch-name-is-confusing`). Mitigations: exactly-one-candidate rule (a second such key blocks action) and prefix exclusions (checkpoint, correction). Residual risk accepted and disclosed; the archive is reversible by design.
- **Stopword sensitivity — VERIFIED (PRD review), no longer open:** `tokenizeMessage` drops "the" (stopword list) and enforces a 3-char floor (2-char digit-bearing exception); "the eval branch name" → exactly `{eval, branch, name}`, matching D1's worked example against the real tokenizer.
- **Expected LOW hit rate on natural corrections — disclosed up front (PRD review).** The containment rule only fires when the correction's subject phrase and the original fact's captured phrase happen to share literal words after two INDEPENDENT `slugify()` passes. The dogfood incident matched because the decision sentence ended with the verbatim phrase "the eval branch name" — a favorable coincidence, not a structural guarantee. A paraphrased original ("we're using dogfood/report as our naming for the eval branch") would produce a key without `eval` or `name` in matching positions and the correction would safely no-op, leaving the stale fact live. Under-matching is therefore the DOMINANT expected failure mode; the mechanism is a precision-safe partial fix, and the bench's expected 0.0pp is consistent with "rarely fires on natural phrasing," not evidence of broad efficacy. Closing the gap generally needs the LLM extraction tier (OD-1/OD-2) proposing supersession targets — deterministically resolved — in a future phase.
- **AX-9 interaction (D5):** if AX-9 lands first, host-summary corrections carry 0.70 confidence yet can archive a 0.85 fact. Accepted for now — recency-of-truth beats stored confidence for corrections — but this is exactly the kind of judgment OD-6's assumptions-profile idea wants to modulate; cross-referenced there.
- **Pre-existing live pair** in the dogfood store (`correction:the-eval-branch-name` + stale decision) is NOT retro-fixed by code that only fires at write time. Handled manually via `iranti_archive` after ship, recorded in the build report — not a migration.
- **`recentDecisions` mixing prefixes** could surprise a host parsing keys by prefix. Documented in tool description; keys keep their real prefixes (no rewriting).

## 10. Verification

Unit (matcher: containment, ambiguity, exclusions, tokenizer parity), integration (incident replay through real attend; rollup read-back), adversarial (cross-project/entity), bench ×2 determinism, full regression.

## Changelog
- 2026-07-04 — proposed (from dogfood review checks 8/10; NF mandate "document, review, implement, review, test, report")
- 2026-07-04 — build-time addendum (tightens D1, strictly safer): supersedable candidates are restricted to the semantic-category prefixes `decision:`, `constraint:`, `preference:`, `failed-approach:` rather than "any non-correction, non-checkpoint key" — a correction plausibly corrects a stated position, never an artifact (`shared-url:*`) or an issue record. Covers the motivating incident; narrows §9's residual mis-target risk further. `CORRECTION_SUPERSEDABLE_PREFIXES` in facts.ts is the single source of truth.
- 2026-07-04 — PRD review (fresh-eyes, verdict ACCEPT-WITH-EDITS): tokenizer math verified against the real `tokenizeMessage` (no longer an open risk); under-matching disclosed as the dominant expected failure mode; bench-neutrality claim empirically verified against all 4 corpora.
- 2026-07-04 — implemented on `feat/dogfood-remediation-1` (25c1fbd9 + 1183460e schema doc; pending NF merge). Dogfood incident replayed verbatim through real attend(): stale decision archived as `superseded_by_correction`, history intact, one live answer; rollup shows corrections both ways. 7 new tests; bench 0.0pp. Code-review gauntlet verdict: MERGE-READY (idempotent re-fire and empty-subject early-return hand-verified by the reviewer).
