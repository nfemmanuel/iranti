# PRD: Layer 0f — No-Answer Honesty (Matched vs Ambient Retrieval)

**Status:** shipped
**Phase:** Layer 0f (YC foundation track) · **Date:** 2026-07-03 · **Author:** Claude (drafted post-mandate; awaiting NF acceptance)
**Related:** Layer 0b PRD D3.4 (falsePositiveRate metric), the external ai-mem benchmark of iranti 0.4.1 (5/5 confident false positives on trick queries), master PRD "confirm, don't discover".

---

## 1. Summary

Make attend() distinguish facts it *matched* to the message from facts it returned as *ambient recency context* — so retrieval knows, and says, when it doesn't know. Today the harness's `falsePositiveRate` reads an honest 100% (8/8 negative probes): every no-answer query still returns confident-looking facts via the recency fallback. This phase adds a deterministic matched/ambient signal to the response and drives that metric toward 0% without sacrificing the ambient-context value hosts get today.

## 2. Problem & motivation

`readRelevantFactsByEntity` keyword-scores facts against the message, but when nothing overlaps it falls back to recency — by design ("guaranteed context"). The external ai-mem bench showed exactly where that design bites: on 5/5 trick queries whose answers didn't exist, old iranti returned plausible-looking wrong context with no boundary marker, and the reviewing agent had no way to tell. The new corpus's 8 negative probes reproduce this in the rebuilt system. A memory layer that cannot say "nothing here answers that" forces every host to guess — the inverse of "confirm, don't discover."

## 3. Goals & non-goals

**Goals**
- A deterministic per-fact (or per-response) signal: this fact MATCHED the message vs. this fact is AMBIENT context.
- `falsePositiveRate` becomes winnable: a negative probe answered with *only ambient-marked* facts (or zero facts) counts as a correct "I don't know."
- Zero regression on hit-rate/confirmation-rate (matched facts keep their ranks).

**Non-goals**
- Removing ambient context entirely (Option A below — rejected unless NF prefers it).
- Any similarity/embedding-based relevance (G1).
- Changing search/query tools (attend-only this phase; others follow the pattern later if accepted).

## 4. Decision for NF (the reason this is `proposed`)

- **Option A — hard threshold:** no keyword overlap → return no facts. Maximal honesty; kills ambient context (hosts lose the "recent facts on this entity" brief that has value on greeting-style turns).
- **Option B — ambient labeling (recommended):** keep today's returned set and ranking, add `matched: boolean` per fact (derived from the existing relevance score > 0, so fully deterministic and already computed). Response shape change is additive. Harness scores a negative probe as correct when no *matched* facts return. Hosts that ignore the flag see today's exact behavior.
- **Option C — status quo:** keep the 100% as a permanent known number.

## 5. Design (Option B — REVISED during build, measured)

- `matched` requires a **KEY-token overlap**: the message must share at least one token with the fact's key (its *name*), not merely a substring buried in its value prose. `readRelevantFactsWithMatch` returns the fact list plus the matched-id set; `attend()` threads it to `AttendResult.facts[].matched`. An alias resolution counts as matched (it is the one deterministic thing known to answer the query). Ranking is unchanged; only the label is stricter than the ranking score.
- **Why revised:** the draft predicted `matched = score > 0` would drive falsePositiveRate to ~0%. Measured: **wrong.** Any-overlap left 7/8 no-answer probes matched (87.5%) because plausible questions naturally brush domain nouns somewhere in some value; key-token-required measured **6/8 (75.0%)**. The residual is structural: questions reuse the domain's nouns in fact *names* too ("ledger", "icon"), and no lexical rule can separate "same domain" from "answers this question." This is the same G1 determinism ceiling as the alias/rules paraphrase gaps, from the inverse direction — documented in §9, not tuned away with thresholds.
- No schema change, no migration; additive response field.
- Harness: `falsePositiveRate` redefined to "any MATCHED fact returned"; the original any-fact definition stays printed alongside as `falsePositiveRateRaw` (reads 100% by design — ambient context is still returned; that is Option B's point). Baseline regenerated at merge per established policy.

## 6. Schema / API changes

None to storage. `AttendResult.facts[].matched: boolean` added (additive). Docs updated for hosts.

## 7. Acceptance criteria (revised to measured reality)

- [x] `facts[].matched` shipped, deterministic (key-token overlap or alias resolution); harness prints both the new matched-only definition and the original any-fact definition (`falsePositiveRateRaw`).
- [x] falsePositiveRate improves measurably: 100% → **75.0%** (-25.0pp). The draft's ~0% prediction was a mis-prediction, not a bar this phase failed to reach: 0% is unreachable for ANY lexical rule (see §5/§9) — the measured residual is the standing, quantified motivation for a future semantic/escalation tier.
- [x] hitRate/confirmationRate/extraction/rules metrics all 0.0pp.
- [x] Determinism assertion holds.
- [x] Adversarial: a message overlapping fact A's key but not fact B's marks exactly A matched (mcp-tools test).
- [x] Cross-project/alias/rules behavior untouched (suites green).

## 8. Deltas from the master PRD

None — implements §"confirm, don't discover" more faithfully.

## 9. Risks & open questions

- Hosts could over-trust `matched` (keyword overlap ≠ semantic answer) — matched is a lexical claim, not a truth claim, and the measured 75% residual on no-answer probes quantifies exactly how often name-vocabulary overlap over-claims on plausible-but-unanswerable questions. Closing it requires semantic understanding (embeddings or an opt-in LLM tier), both outside G1's deterministic core — the residual is the measured case for that future tier, mirroring how the alias probes motivated entity resolution.
- The stricter key-token rule can UNDER-claim — and this is **already live in the reference corpus, not hypothetical** (review finding): the messy-conversationalist probe "What does the new tool need to do when it fails?" ranks `constraint:whatever-we-build-next-has-to-send-a-sla` at #1 (hit, confirmed — a fully correct answer) yet labels it `matched: false`, because the query overlaps the fact's *value* ("fails") but shares no token with its truncated key. Not scored by any current metric; accepted as the conservative side of the trade (an ambient label on a true answer is safer than a matched label on a wrong one), but any future matched-quality metric should score exactly this case.
- **Short-identifier cross-matching (review finding):** `hasKeyTokenMatch`'s key side has no length floor, and digit-bearing 2-char tokens (s3, r2, version numbers like "16") pass the message side's RULE-1 rule — so a fact keyed `decision:migrate-to-s3-storage` reads `matched: true` against a semantically unrelated "is s3 down for anyone else?" on that single shared token. Only one benign incidental case exists in the corpus today (a Postgres "16"); documented here as a live mechanism alongside the domain-noun ceiling rather than left implicit.
- Whether `iranti_search`/`iranti_query` should get the same flag in this phase or a follow-up (lean: follow-up).

## 10. Verification

Harness negative probes (primary), unit tests on the score→matched threading, full suite + bench determinism.

## Changelog
- 2026-07-03 — proposed (drafted post-overnight-mandate)
- 2026-07-03 — accepted: NF chose OPTION B (ambient labeling) via decision prompt
- 2026-07-03 — shipped (feat/layer0f-no-answer; measured 100%→75.0% matched-fact false positives; review 0 BLOCKER/MAJOR + 3 MINOR all fixed)
