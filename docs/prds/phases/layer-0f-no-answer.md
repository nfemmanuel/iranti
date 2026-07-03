# PRD: Layer 0f — No-Answer Honesty (Matched vs Ambient Retrieval)

**Status:** proposed
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

## 5. Design sketch (Option B)

- `readRelevantFactsByEntity` already computes a relevance score per fact before the recency fallback; thread `matched = score > 0` through to `AttendResult.facts[]` (and `peripheral` marked ambient always).
- No schema change, no migration; additive response field.
- Harness: `falsePositiveRate` definition updates from "any fact returned" to "any MATCHED fact returned" — the stricter original definition remains printed alongside for one release as `falsePositiveRateRaw` so the improvement is visible as a delta, not a definition swap. Baseline regenerated at merge per established policy.
- Expected efficacy: falsePositiveRate 100% → ~0% (8/8 negative probes return ambient-only); hitRate/confirmationRate 0.0pp.

## 6. Schema / API changes

None to storage. `AttendResult.facts[].matched: boolean` added (additive). Docs updated for hosts.

## 7. Acceptance criteria (draft)

- [ ] Negative probes: 0/8 matched-fact false positives; harness prints both old and new definitions for one release.
- [ ] hitRate/confirmationRate/extraction metrics 0.0pp.
- [ ] Determinism assertion holds.
- [ ] Adversarial: a message with overlap to fact A but not fact B marks exactly A matched.
- [ ] Cross-project/alias/rules behavior untouched (suites green).

## 8. Deltas from the master PRD

None — implements §"confirm, don't discover" more faithfully.

## 9. Risks & open questions

- Hosts could over-trust `matched` (keyword overlap ≠ semantic answer) — document that matched is a lexical claim, not a truth claim.
- Whether `iranti_search`/`iranti_query` should get the same flag in this phase or a follow-up (lean: follow-up).

## 10. Verification

Harness negative probes (primary), unit tests on the score→matched threading, full suite + bench determinism.

## Changelog
- 2026-07-03 — proposed (drafted post-overnight-mandate; NF decision needed on Option A vs B vs C before any code)
