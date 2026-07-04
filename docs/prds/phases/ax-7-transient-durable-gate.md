# PRD: AX-7 — Transient-vs-Durable Fact Gate

**Status:** proposed
**Phase:** AX-7 (hardening) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** register AX-7 row ("stop storing volatile facts (`typecheck_status=clean`)", verify metric: "0 stored VOLATILE-pattern facts"), master PRD §2 (stores what has future learning value, discards what doesn't), AX-9 (precision-over-recall posture). NF greenlight 2026-07-04.

---

## 1. Summary

A deterministic write-path gate that stops *volatile* observations — values true only at the moment of writing (build status, running ports, "currently on branch X", timestamps-as-state) — from being stored as durable facts. Volatile facts are worse than useless: they are confidently wrong the moment circumstances change, and old-iranti's live store accumulated exactly this class (`typecheck_status=clean` was the register's motivating example).

## 2. Problem & motivation

The extractor and hosts write facts like "build is green", "server running on port 3000", "typecheck clean". Each is true for minutes. A memory layer that replays them days later actively misleads — the inverse of "eliminate hallucination caused by missing or degraded context." The register named this AX-7 with a measurable bar: zero stored volatile-pattern facts.

## 3. Goals & non-goals

**Goals**
- A deterministic `classifyVolatility(key, value)` check at the `writeFact` boundary: known-volatile shapes are intercepted.
- Interception is **soft, not silent**: volatile writes are downgraded, not dropped — stored with a `transient: true` marker (metadata) and excluded from attend/search retrieval by default, so nothing is invisibly lost (never-hard-delete spirit at the write end) and the gate's own false positives are recoverable and auditable.
- Explicit escape hatch: a caller passing `durable: true` (e.g. the host insists) bypasses the gate — the gate guards defaults, it does not overrule intent.
- Bench/verify: corpus gains volatile-write probes (messages stating volatile facts; gold = NOT retrievable as durable); register's "0 stored VOLATILE-pattern facts" becomes a printed check.

**Non-goals**
- TTL/decay machinery (Phase 4's job — this is a write-time classification, not a lifecycle).
- LLM-based volatility judgment (G1; patterns only, precision over recall: an uncaught volatile fact is the status quo, a wrongly-suppressed durable fact is a new harm — so patterns must be narrow).

## 4. Scope

**In:** `src/library/volatility.ts` (pattern set + classifier, pure, unit-tested); `writeFact` integration (metadata marker + retrieval exclusion in the read paths that feed attend/search); extractor sources included (heuristic + host writes all flow through writeFact); volatile-probe corpus additions (red-first where the current system stores them); tests incl. escape hatch + audit visibility (transient facts visible via history/includeInactive-style audit read).
**Out:** retro-cleanup migration of existing volatile facts in live stores (manual/cutover-time task, noted in Layer 0g migration scope); Phase 4 decay.

## 5. Design decisions

- **D1 — Downgrade, don't drop.** A dropped write is a silent failure (the market's junk-tool failure mode inverted); a stored-but-transient fact is auditable and reversible. Rejected: hard rejection with error (hosts would retry/fight it).
- **D2 — Narrow pattern classes, enumerated:** key-shapes (`*_status`, `*-status`, `port`, `pid`, `running`, `currently-*`) AND value-shapes (bare port numbers with runtime nouns, "is running/passing/green/clean *now*"-class predicates). Every pattern ships with positive+negative unit fixtures; when in doubt, the fact stays durable (precision over recall, inverted correctly for this gate).
- **D3 — Gate lives at writeFact**, not in extractors — one choke point covers heuristic, LLM-future, host-explicit, and autowrite paths identically.
- **D4 — `transient: true` rides facts.metadata** (no migration), mirroring AX-1's rawKey precedent.

## 6. Schema / API changes

None to tables. `writeFact` input gains optional `durable?: boolean` (default undefined = gate applies). `iranti_write` tool schema exposes it with a one-line description.

## 7. Acceptance criteria

- [ ] Classifier unit suite: every pattern has fire + near-miss-must-not-fire fixtures ("port 3000 is the default for the dev server" = durable config fact, must NOT gate; "server is running on port 3000" = volatile).
- [ ] Volatile write → stored with transient marker, absent from attend facts[]/search results, visible via history/audit path.
- [ ] `durable: true` bypasses; extractor writes flow through the gate.
- [ ] Corpus volatile probes red-first then green; bench ×2 deterministic; all unrelated metrics 0.0pp; deltas explained.
- [ ] tsc/lint 0; full-suite no regressions.

## 8. Deltas from master PRD

None — implements §2's "discards information with no signal" for the volatile class, with an audit trail instead of true discarding.

## 9. Risks & open questions

- False-positive suppression of a genuinely durable fact is the real risk; mitigated by narrow enumerated patterns, the durable:true hatch, audit visibility, and unit-pinned near-misses. Any live false positive adds a near-miss fixture in the same commit as its pattern fix.
- Pattern list will grow forever like all such lists; acceptable — same maintenance model as the extractor patterns, now watched by the fabrication corpus discipline.
- Whether attend should surface transient facts within-session (same session that wrote them) is deferred: v1 excludes them uniformly; a "session-scoped recall" refinement is a future measured change.

## Changelog
- 2026-07-04 — proposed (NF greenlight; wave-1 mandate)
