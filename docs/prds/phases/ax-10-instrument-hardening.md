# PRD: AX-10 — Instrument Hardening (Evolving Fabrication Corpus + Gold-Hash Lint)

**Status:** proposed
**Phase:** AX-10 (hardening) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** AX-9 (fabricationProbes/fabricationRate shipped there), dogfood remediation report (13/13 adversarial stress demo), the 3×-observed bad-hash gold defect class. NF greenlight: "expand the trickier trap sentences thing into a permanent test suite, but keep it evolving so that we don't overfit into that one scenario."

---

## 1. Summary

Two instrument upgrades, no engine behavior change. (1) Promote the 13-sentence adversarial stress set — which fabricated 13/13 against the post-AX-9 extractor — into the permanent corpus as fabrication probes, with an explicit growth policy so the suite keeps getting harder instead of freezing at one scenario. (2) A corpus lint that recomputes every content-hash gold key from its own value, killing the hand-typed-hash defect that has now produced three silent instrument lies.

## 2. Problem & motivation

- AX-9's fabricationRate reads 0.0% — but only because its 8 probes cover the one killed vector class. The stress demo proved the verb-pattern classes (must-have idiom, using-up aspect, agreed-gossip, didn't-work events, please/make-sure ephemera, actually-status-updates) fabricate freely. A 0.0% that NF correctly called "insanely low" must become an honest red number the next hardening round is measured against.
- Three corpus golds have now carried wrong hand-written hashes (two labeled placeholders caught by review, one unlabeled twin found during the recall-plateau investigation). Each silently misreported recall. The class dies only if the instrument checks itself.

## 3. Goals & non-goals

**Goals**
- The 13 stress sentences (verbatim from the remediation report's demo) land as `fabricationProbes` across the 4 personas, voice-matched; fabricationRate prints its honest post-addition number (expected ≈ 13-in-21 red on the classes not yet fixed) and becomes the standing scoreboard for extraction-guard work.
- A written growth policy in the corpus README: every live fabrication incident and every newly identified pattern class adds probes in the same commit as (or before) its fix; probes are NEVER removed, only added; a quarterly-style "author fresh sentences without looking at the pattern list" note guards against teaching-to-the-test.
- `pnpm lint:corpus` (script + wired into `pnpm bench` preflight): for every gold whose key matches `<prefix>:<12-hex>` where prefix ∈ {referenced_file, shared_url} (normalized or raw form), recompute sha256(value).slice(0,12) and FAIL with the expected key on mismatch.

**Non-goals**
- Fixing the fabrication classes the new probes expose (that is the extraction-tier work, gated on the measurement protocol — this PRD only makes the failure visible and permanent).
- Any change to extractor code, retrieval, or metrics definitions.

## 4. Scope

**In:** bench/corpus/*.json probe additions (insertion-only); `scripts/lint-corpus.mjs` (or ts equivalent runnable without build); package.json script; harness preflight call; corpus README growth-policy section; bench run + baseline advance (fabricationRate will move — that is the point; every delta explained).
**Out:** new metric definitions (fabricationRate already exists); rotating/holdout probe sets (noted in §9 as the future anti-overfit escalation).

## 5. Design decisions

- **D1 — Probes are permanent and additive.** Removal would let a regression hide; the suite only grows. Anti-overfit is handled by authorship discipline (fresh sentences authored blind) not by pruning.
- **D2 — Voice-match the 13 to personas** (backend gets the infra-flavored ones, messy gets the lol-flavored ones) so the corpus stays a realistic conversation record, not a lab list.
- **D3 — Lint is a hard preflight failure**, not a warning — a wrong gold hash is a lying instrument, strictly worse than a broken build.
- **D4 — Lint recomputes from the gold's `value` field** — the value IS the artifact string by convention for hash-keyed golds; no message re-parsing (keeps the lint trivial and deterministic).

## 6. Schema / API changes

None.

## 7. Acceptance criteria

- [ ] 13 stress sentences present as fabricationProbes, insertion-only diff on existing entries.
- [ ] `pnpm bench` prints the new honest fabricationRate (red), all other metrics 0.0pp, determinism ×2 holds; baseline advanced with deltas explained.
- [ ] `pnpm lint:corpus` passes on the fixed corpus; seeded with a deliberate bad hash in a test fixture it fails naming the expected key; wired so `pnpm bench` cannot run against a lying corpus.
- [ ] Growth policy documented in bench/corpus README (create it if absent).

## 8. Deltas from master PRD

None — measurement-only.

## 9. Risks & open questions

- The honest fabricationRate number will look bad in the scoreboard until the extraction tier lands. Accepted deliberately — same posture as falsePositiveRate-100% and rules-81.3%.
- Growth-by-discipline can still drift toward test-teaching over time; the named escalation (not built now) is a rotating holdout set scored but not published per-probe.
- Lint covers hash-keyed golds only; slug-keyed golds (decision:*, etc.) are mechanically derived by extractors and can't be independently recomputed without re-running extraction — out of scope, disclosed.

## Changelog
- 2026-07-04 — proposed (NF greenlight; wave-1 mandate)
