# PRD: OD-6 — Evolving Assumptions Profile (PLAN ONLY — not scheduled)

**Status:** proposed — **explicitly not scheduled for build** (NF: "we can write a plan for it but it isn't very important to implement it just yet")
**Phase:** unscheduled · **Date:** 2026-07-04 · **Author:** NF (idea) + Claude (plan)
**Related:** register OD-6, Layer 0i §9 (first named consumer: correction-vs-confidence judgment), Layer 0f (matched labeling precedent for marked epistemic boundaries), G1 (never invents — the tension this must resolve).

---

## 1. Summary (the idea, in NF's framing)

iranti maintains a small set of general assumptions about the user and the system that evolve with use — "user may not fully understand this project and needs research" maturing into "user has consulted others and prioritizes approach X"; "user is math-literate" maturing into "user has a PhD in applied quantum mechanics." Injected as ambient context, and used to modulate iranti's own behavior: confidence assigned to facts, and the fervor with which rules are suggested and facts injected. NF's added insight (2026-07-04): the profile doubles as a **legible timeline of how the system's picture of the user evolved** — an auditable history, not a hidden knob.

## 2. Why it earns a plan now (and not a build)

Two live consumers already exist on paper: (a) Layer 0i §9's open judgment — should a low-confidence host-summary correction supersede a higher-confidence fact? An assumptions profile ("user X reliably corrects precisely") is exactly the modulation that question wants. (b) Injection fervor — the token-economy redesign wants a principled dial for how aggressively to push rules/facts; "user knows this domain cold" is that dial's natural input. Neither blocks v1.0; both get better with real usage data to calibrate against — hence: plan now, build after the core loop is proven in daily use.

## 3. Design sketch (lean, to be validated at build time)

- **Storage: option (a) from the register** — a reserved `assumption:*` category on `user/*` and `system/*` entities, using ordinary write/supersession/history mechanics. The evolution story falls out for free: supersession IS the evolution, and `iranti_history` on an assumption key IS NF's "see the way a user evolved" timeline. Rejected-for-now: dedicated table (machinery before evidence), host-side-only (loses the timeline and the modulation hooks).
- **The G1 boundary:** assumptions are inferences, not observations. Hard rules: (1) reserved `assumption:` prefix, never mixed with fact categories; (2) provenance label (`source: assumption_engine` or the proposing agent) mandatory; (3) NEVER surfaced in attend `facts[]` — a dedicated `assumptions[]` response field (0f labeling precedent), so no host can mistake an inference for a recorded fact; (4) correctable/archivable like everything else.
- **Evolution mechanics v1: proposals, not autonomy.** Hosts/agents propose assumption updates via ordinary writes (same-key supersession = refinement); iranti stores, timelines, and surfaces them. Autonomous inference of assumptions (iranti deriving "user is expert" from behavior) is explicitly a LATER, separately-gated step — likely the LLM tier's job with the grounding discipline applied to inferences (cite the behavioral evidence spans).
- **Modulation hooks (the operative part), in gated order:** first ship SURFACING only (assumptions[] visible, influencing nothing) → measure whether hosts use them → then wire the two named consumers (0i correction-confidence tiebreak; injection-fervor budget weighting), each as its own measured change with a bench story.
- **Confidence on assumptions** starts as plain fact confidence; no bespoke calculus until usage shows the need.

## 4. Acceptance criteria (for whenever it IS scheduled)

- [ ] `assumption:*` writes store/supersede/timeline via existing mechanics; history shows the evolution chain end-to-end.
- [ ] attend returns `assumptions[]` (budgeted, labeled), never mixing them into `facts[]`; hosts ignoring the field see zero behavior change.
- [ ] Adversarial: assumptions never satisfy a fact probe, never flip `matched`, never cross projects.
- [ ] The 0i correction-confidence consumer wired ONLY behind its own measured PRD addendum.

## 5. Risks

- Inference creep: the whole feature is licensed invention unless the §3 boundary rules are enforced mechanically (prefix + field separation are code, not convention).
- Profile staleness cuts the other way (an outdated "user is a beginner" is patronizing noise) — supersession + visibility is the mitigation; decay interplay deferred to Phase 4.
- Privacy weight: an epistemic dossier on the user is sensitive by nature — local-first posture covers v1; any future sync must treat assumptions as the most-sensitive class.

## Changelog
- 2026-07-04 — proposed as PLAN-ONLY; not scheduled (NF directive). Revisit trigger: post-v1.0 daily-driver usage, or whenever the 0i correction-confidence question hurts in practice.
