# PRD: Layer 0d — Rules & Preferences Enforcement (situational relevance)

**Status:** shipped
**Phase:** Layer 0d (YC foundation track) · **Date:** 2026-07-03 · **Author:** NF + Claude
**Related:** master PRD (standing-preferences claim — the product owner's #1 feature), Layer 0 PRD (`layer-0-foundation.md` — project scoping this feature must respect), Layer 0b PRD (`layer-0b-harness.md` — the measurement instrument this PRD's efficacy gate extends), Layer 0c PRD (`layer-0c-entity-resolution.md` — the alias/rank-1 invariant this PRD must not break). Pre-authorized by the overnight mandate as the #1 feature.

---

## 1. Summary

`iranti_write_rule` and `getRulesForAttend` already exist, but "relevance" today means only **entity scope** (system/global + hinted entities) — every active rule for every entity in scope is injected on every single `attend()` call, regardless of what the current message is about. A rule like "never use SELECT * in the reporting queries" is just as present in the injection block when the conversation is about a Redis cache as when it's about a reporting query. This PRD adds a second, deterministic filter — **situational relevance** — so a rule surfaces when the current message content makes it applicable, and stays silent otherwise, without ever using embeddings or an LLM call at attend time (G1). It also extends the Layer 0b measurement harness with a rules dimension (`ruleRelevanceRate`, `ruleNoiseRate`) and adds a scripted multi-turn host-simulation suite that proves the behavior end-to-end through the real `attend()` path.

## 2. Problem & motivation

Standing rules are the product owner's #1 feature, but today's implementation has two gaps:

1. **No situational gating.** `getRulesForAttend` (src/library/rules.ts) takes `entityHints` only — no `message` parameter exists at all. Every active rule scoped to an entity in the hint list is returned, every turn, unconditionally. A team with 15 standing rules on one project gets all 15 injected into every response, most of them irrelevant to what's being discussed. This is the "dumped every turn" failure mode the mandate explicitly warns against — it burns context budget and trains users/agents to skim past (and eventually ignore) the rules block.
2. **The corpus already contains rule-shaped content the product should treat as rules, not facts.** All four personas' transcripts contain an explicit standing-preference statement in the last 1-2 messages: backend ("Never use SELECT * in the reporting queries"), frontend ("always add an aria-label to icon-only buttons", "Never ship a component without a loading and an error state"), messy ("never touch the export script on Fridays" — a documented extractor MISS today, gold-noted as such). Today these are captured (or missed) by the `HeuristicExtractor`'s `PREFERENCE_PATTERNS`/`CONSTRAINT_PATTERNS` as **facts** (key `preference:*`), not as `rules` table rows — because there is no bridge from "detected preference-shaped sentence" to `writeRule`. That is a real, separate gap, but this PRD does not close it (see §3 non-goals) — closing it would mean teaching the extractor to auto-promote fact-shaped text to imperative rules, a materially different (and riskier) capability than gating relevance for rules that are already written. This PRD's job is: once a rule EXISTS (via `iranti_write_rule`, the only current write path), make sure it fires when relevant and stays quiet when not.

## 3. Goals & non-goals

**Goals**
- A deterministic, explainable relevance function that decides whether an already-active, in-scope rule is injected on a given `attend()` call, using only the current message text and the rule's own text/scope/priority (G1 — no embeddings, no LLM at attend time).
- A precedence/budget model: rules are capped per attend call, ordered so the most relevant + highest-priority rules win the slot when more relevant rules exist than budget allows.
- Preserve every existing invariant: rules differ from facts (imperative, no decay, additive), the alias rank-1 guarantee (Layer 0c), the one-id-one-entry dedup, and project scoping (a rule from project A never fires in project B).
- Backward compatibility: `getRulesForAttend([...])` called with **no message** (existing call sites: `rules.test.ts`, `projects-isolation.test.ts`, `mcp-tools.test.ts`'s `"returns rules for hinted entities plus system/global"`) must continue to return the unfiltered, entity-scoped rule set exactly as today — situational gating only activates when a message is present, mirroring `readRelevantFactsByEntity`'s own "no message → no filtering" fallback (src/library/facts.ts).
- Extend the Layer 0b harness with a rules dimension: `ruleRelevanceRate` (expected rule surfaced on a positive rule probe) and `ruleNoiseRate` (a rule fires on a negative rule probe where none should), wired through `scorer.ts`/`baseline.ts`/`report.ts` exactly like `falsePositiveRate` was.
- A scripted, multi-turn host-simulation test suite driving the real `attend()`/`iranti_write_rule` path end-to-end (write → situational surfacing → non-firing on an unrelated turn → deactivation → cross-project isolation → restart persistence).

**Non-goals**
- Auto-promoting extractor-detected preference/constraint facts into `rules` table rows. The corpus's rule-shaped sentences remain scored as facts (as today); this PRD adds NEW `ruleProbes` that explicitly write rules via `iranti_write_rule` and then probe situational surfacing — it does not change what the existing extraction pipeline does with those sentences. Flagged as a named follow-up (§9).
- Fuzzy/semantic rule matching (embedding similarity, LLM classification of "is this rule relevant"). G1 forbids it outright.
- A rule "scope/tags" schema column (e.g. explicit `appliesTo: ["sql", "reporting"]` metadata authored at write time). Considered and rejected for Layer 0d — see D1.
- Changing `iranti_write_rule`'s input schema (no new required fields) — situational relevance is computed entirely from the rule's existing `text` and `priority`, so no migration and no tool-signature break.
- Rule correction/supersession UX (e.g. "update rule X's text" as a first-class operation distinct from deactivate+rewrite). `deactivateRule` already exists; this PRD does not add a new lifecycle verb. Flagged as an open question (§9).
- Fixing the pre-existing `falsePositiveRate: 100%` on fact negative probes (a known, already-shipped Layer 0b finding, unrelated to rules). Out of scope here.

## 4. Scope

**In**
- `src/library/rules.ts`: `getRulesForAttend` gains an optional `message?: string` parameter and a situational relevance filter, applied only when a message is present.
- A new pure function, `scoreRuleRelevance(rule, tokens)` (or equivalent), reusing the same tokenization approach as `facts.ts`'s `tokenizeMessage`/`scoreRelevance` (keyword/token overlap between message and rule text) for cross-codebase consistency (G1).
- A priority floor: rules at `priority >= CRITICAL_RULE_PRIORITY` (100, matching the existing documented scale in schema.ts/rules.ts) are ALWAYS injected regardless of message relevance — "hard constraints" per the existing priority-scale comment. Rules below that threshold are subject to situational gating when a message is present.
- A rule budget: `MAX_RULES_PER_ATTEND` (new constant in `attend.ts`, alongside `MAX_FACTS_PER_ENTITY`/`MAX_TOTAL_FACTS`), applied AFTER relevance filtering and priority sort, so the most relevant+highest-priority rules win when more qualify than the budget allows.
- Harness extension: `ruleProbes` field on `CorpusProbe`-adjacent corpus shape (new `RuleProbe` type in `types.ts`), 2-3 positive + 1-2 negative rule probes per persona corpus (additive JSON edits — new probes/messages only, no existing message/goldFact/probe touched).
- New harness messages: each persona corpus gains one or two NEW transcript messages that explicitly declare a rule via the same shape `iranti_write_rule` expects (the harness calls `writeRule` directly, mirroring how `ingest.ts` already calls `attend()` for facts — seeding a rule is a distinct write path, not a message the extractor parses).
- New metrics `ruleRelevanceRate` and `ruleNoiseRate` in `scorer.ts`, wired through `baseline.ts` (NaN-coalesced exactly like `falsePositiveRate` was) and `report.ts`.
- `src/tests/rules-relevance.test.ts` (or similar): unit tests for the relevance/budget function itself.
- `src/tests/host-simulation.test.ts`: scripted multi-turn session proving the full lifecycle through real `attend()`/`iranti_write_rule`.

**Out (deferred)**
- Extractor-to-rule auto-promotion — deferred, owner TBD, tracked in §9.
- Rule scope/tags authoring surface — deferred; token-overlap on `text` is the G1-compliant Layer 0d answer (D1).
- `iranti_update_rule` / correction-as-supersession lifecycle verb — deferred (§9).

## 5. Design decisions & rationale

- **D1 — Relevance signal is keyword/token overlap between the message and the rule's own `text`, not a new scope/tags schema.** *Why:* `facts.ts` already has exactly this pattern (`tokenizeMessage` + `scoreRelevance`, keyed on key-tokens and value-text) proven deterministic and cheap; reusing the same tokenizer means one mental model for "relevance" across facts and rules, and zero new authoring burden on `iranti_write_rule` callers (a rule author writes natural language, same as today — no separate tag list to keep in sync with the text). *Rejected:* an explicit `tags: string[]` or `appliesTo` column authored at write time. This would require every `iranti_write_rule` caller (today: any MCP host) to correctly anticipate every future message phrasing that should trigger the rule — a curation burden that doesn't scale and silently under-fires the moment a user phrases the SQL query question differently than the tag author expected. Text-overlap generalizes to any phrasing sharing vocabulary with the rule itself, which is exactly the situational-relevance bar the mandate sets, at zero authoring cost.
- **D2 — Priority floor for "always injected" hard constraints, distinct from situational gating.** Rules at `priority >= 100` (already documented in schema.ts as "100+ critical (tone, safety, hard constraints)") bypass relevance filtering entirely — they are injected on every attend call in scope, exactly like today. *Why:* the existing priority scale already encodes an author's declaration of "this is non-negotiable, not situational" (the schema.ts comment's own example: "never use em dashes in any response" — a rule that applies to EVERY response, not a subset). Forcing critical rules through keyword gating would silently break that existing contract and is likely to under-fire on exactly the rules meant never to be skipped. *Rejected:* gating ALL rules regardless of priority — this technically satisfies "situational relevance" but breaks the documented priority-tier semantics that already exist in the schema and is a strictly worse user experience for the "never do X" class of rule the product owner explicitly named in the mandate ("never touch the export script on Fridays" reads as exactly this kind of always-relevant hard constraint if the author sets its priority high).
- **D3 — Relevance gating activates ONLY when `attend()` is called with a message.** No-message calls (today: 5 existing tests, including `mcp-tools.test.ts`'s `"returns rules for hinted entities plus system/global"` at priority 50 — below the D2 floor) get the full entity-scoped set, unfiltered, unchanged from today. *Why:* this exactly mirrors `readRelevantFactsByEntity`'s own contract (`if (!message) return readRecentFactsByEntity(...)` — no filtering without a signal to filter against) and — critically — preserves 100% backward compatibility with every existing rules-related test without changing a single existing assertion. *Rejected:* defaulting to "inject nothing below the priority floor when there's no message" — this would break the existing `mcp-tools.test.ts` assertion (a priority-50 rule expected present with no message) and has no situational signal to justify suppressing a rule the caller explicitly scoped to this entity.
- **D4 — Budget: `MAX_RULES_PER_ATTEND = 5`.** Applied after relevance filtering + priority-desc sort (existing `getRulesForAttend` order), so critical (D2) rules always occupy the top slots, then the highest-scoring relevant rules fill the rest. *Why 5:* rules are meant to be read and followed by the agent on every turn — unlike facts (browsable reference material), a long rules block defeats its own purpose (the "dumped every turn" failure mode). 5 comfortably covers "a few critical constraints + 1-3 situationally relevant ones" without becoming noise. *Rejected:* no cap (today's behavior) — directly contradicts the mandate's "not dumped every turn" requirement once a project accumulates more than a handful of rules. *Rejected:* reusing `MAX_FACTS_PER_ENTITY` (10) — rules are imperative and meant to be actively obeyed, a materially different budget economics than "browsable facts," so a distinct (smaller) constant is honest about that difference rather than reusing an unrelated number that happens to exist.
- **D5 — Rules differ from facts in the response by REMAINING imperative-only, additive, and un-ranked-by-recency; the `rules[]` section semantics do not change shape.** `AttendResult.rules` keeps its existing `{ entity, text, priority }` shape (src/mcp/tools/attend.ts) — no new field is added to the wire format (e.g. no `relevanceScore` leaked to the caller) because the relevance filter is an internal retrieval decision, not new information the host needs to render differently. *Why:* the mandate frames rules as things that "demonstrably shape agent behavior" via presence/absence — a numeric score on each rule invites the host to build its own (weaker) filtering logic on top instead of trusting iranti's decision, which undermines the "iranti decides what is relevant, the agent never selects rules manually" principle already documented in rules.ts's header comment. *Rejected:* adding `relevanceScore` to the response — would leak an internal, versioned heuristic as part of the public contract, coupling future tuning of the scorer to a wire-format change.
- **D6 — Noise definition: a NEGATIVE rule probe is a message unrelated (zero token overlap, not just "different topic in the same domain") to every active rule's text, scoped to entities that DO have active rules.** `ruleNoiseRate` = (rule count returned on negative rule probes) / (negative rule probe count), lower is better — exact mirror of `falsePositiveRate`'s definition and formula shape in `scorer.ts`. *Why this exact definition:* it isolates "did the situational filter correctly withhold an irrelevant rule" from "does this entity have any rules at all" — the probe's entity DOES have rules (so a naive "always inject everything in scope" implementation would show noise), which is the precise behavior D1-D4 are supposed to prevent. *Rejected:* measuring noise as "any rule ever injected when the true correct answer needed zero rules" without requiring the entity to already have active rules — that would conflate "no rules exist" with "the filter suppressed a rule," which don't test the same capability.
- **D7 — `ruleRelevanceRate` mirrors `hitRate`'s shape exactly**, scoped to positive rule probes only: (rule probes where `expectedRuleKeys`' rule text appears in `rules[]`) / (positive rule probe count). No separate "confirmation rate" for rules (no rank-1 requirement) — unlike facts, rules are not a ranked list a host reads top-to-bottom for "the one right answer"; a rule being present anywhere in the (budget-capped, priority-sorted) `rules[]` array is the pass condition, matching how the response is actually consumed (an agent reads the whole rules block as directives, not "the first one"). *Rejected:* requiring rank 1 — meaningless for an additive, imperative list where multiple rules can and should coexist in the same response.
- **D8 — No schema change / no migration.** The relevance signal is computed entirely from the EXISTING `rules.text` and `rules.priority` columns at read time inside `getRulesForAttend` — no new column, no new table. *Why:* G1's determinism requirement is about the SIGNAL (keyword overlap, computed fresh from stored text every call) not about persisted metadata; storing a precomputed tag/score would need its own invalidation story (what happens when a rule's `text` changes — it can't, rules are immutable/additive per D-none-in-rules.ts — so a persisted field would never go stale, but it also isn't needed to make the read-time computation deterministic). *Rejected:* a migration adding a `keywords: text[]` column populated at write time — adds write-path complexity and a second source of truth for something fully derivable from `text` at read time for a handful of rows (rules are low-volume by nature: additive, human-authored, no decay).
- **D9 — Lifecycle: `deactivateRule` (existing) is the only correction path in Layer 0d; no new supersession primitive.** To "correct" a rule, the existing pattern (deactivate old, write new — already documented in rules.ts's header comment) is unchanged. Situational relevance interacts with this cleanly: a deactivated rule is already excluded by `getRulesForAttend`'s `isActive` filter (pre-existing), so it never reaches the relevance filter at all — no new interaction to design. *Flagged, not built:* an explicit "this rule replaces rule X" link (for audit/history, mirroring how `entity_aliases` tracks `fact_key` pointers) is a real gap but not required by any acceptance criterion here — see §9.

## 6. Schema / API changes

**Schema:** None. No migration. (See D8.)

**`src/library/rules.ts` — `getRulesForAttend` signature change:**
```ts
export async function getRulesForAttend(
  entityHints: Array<{ entityType: string; entityId: string }>,
  tenantId: string = "default",
  project: string | string[] = "default",
  message?: string,          // NEW, optional, appended last for backward compat
): Promise<Rule[]>
```
Behavior: unchanged when `message` is omitted/undefined (D3). When present: rules with `priority >= CRITICAL_RULE_PRIORITY` (100) always pass; rules below that threshold pass only if `scoreRuleRelevance(rule.text, tokens) > 0`. Passing rules keep the existing priority-DESC order (relevance score is NOT a secondary sort key — priority remains authoritative among relevant rules, consistent with the pre-existing documented ordering contract).

**`src/mcp/tools/attend.ts`:**
- New exported constant `MAX_RULES_PER_ATTEND = 5`.
- The existing call site (`const rules = isMidTurn ? [] : await getRulesForAttend(hints, "default", effectiveProjectIds);`) gains `input.message` as the 4th argument, then the result is capped: `.slice(0, MAX_RULES_PER_ATTEND)` before entering the existing token-budget (`fitsBudget`) pipeline — cap-then-budget, same order facts already use (`MAX_TOTAL_FACTS` then `fitsBudget`).
- No change to `AttendResult`'s shape (D5).

**`src/harness/types.ts`:**
```ts
export interface RuleProbe {
  query: string;
  entityHints: Array<{ entityType: string; entityId: string }>;
  // Substring (case-insensitive) expected to appear in some rule's `text` in
  // the attend() response's rules[]. Empty + negative:true for negative probes.
  expectedRuleTextContains: string[];
  negative?: boolean;
  note?: string;
}

// A rule the corpus author declares via the real write path (writeRule),
// BEFORE any probes run — mirrors how goldFacts declare expected extraction
// outcomes, but rules have no extraction path; they must be seeded explicitly.
export interface CorpusRule {
  entityType: string;
  entityId: string;   // "global" for entityType "system"
  text: string;
  priority: number;
}
```
`Corpus` gains two new OPTIONAL fields: `rules?: CorpusRule[]` (seeded before ingest) and `ruleProbes?: RuleProbe[]` (run after ingest, alongside existing `probes`). Optional so this is additive to the existing corpus JSON shape without requiring every persona to have them (though this PRD adds them to all 4).

**`src/harness/scorer.ts`:** new `RuleRetrievalScore` interface (mirrors `RetrievalScore`) with `ruleRelevanceRate`, `ruleNoiseRate`, `ruleProbeCount`, `ruleHitCount`, `ruleNegativeCount`, `ruleNoiseCount`, `perRuleProbe`. Added to `PersonaReport`/`OverallReport` as a new `rules` field (sibling to `extraction`/`retrieval`), micro-averaged the same way.

**`src/harness/baseline.ts`:** two new diffed metrics, `overall.rules.ruleRelevanceRate` and `overall.rules.ruleNoiseRate` (+ per-persona variants), NaN-coalesced exactly like `falsePositiveRate` so a pre-existing baseline (generated before this PRD) prints `(no baseline)` instead of a fabricated delta.

**`src/harness/report.ts`:** a new `no-rule` (or `rules`) line per persona and in the overall block, same `pct()`/delta formatting as the existing false-positive line.

## 7. Acceptance criteria

- [x] `docs/prds/phases/layer-0d-rules-enforcement.md` (this file) exists, accepted, committed before any code.
- [x] `getRulesForAttend` accepts an optional `message` param; all 5 existing call sites with no message (`rules.test.ts` x3, `projects-isolation.test.ts` x2) and the `mcp-tools.test.ts` no-message rules test are UNCHANGED and green.
- [x] Situational relevance: a rule below the critical-priority floor is injected when the message shares vocabulary with the rule's text, and is NOT injected on an unrelated message — proven by both a unit test and the host-simulation suite.
- [x] Critical-priority rules (>=100) are always injected regardless of message content, in scope.
- [x] `MAX_RULES_PER_ATTEND` budget enforced; most relevant/highest-priority rules win when more qualify than the budget.
- [x] Cross-project isolation preserved: a rule from project A never fires in project B (existing `projects-isolation.test.ts` case untouched + new host-simulation case).
- [x] Alias rank-1 invariant and one-id-one-entry dedup (Layer 0c) unmodified and still green (`aliases.test.ts` 17/17 unaffected — rules and facts are independent tiers in `attend()`).
- [x] Harness: each of the 4 persona corpora gains `rules` (seed) + `ruleProbes` (2-3 positive + 1-2 negative) — additive JSON only, zero bytes changed in existing `messages`/`goldFacts`/`probes`/`ruleProbes`-absent fields (`git diff` reviewed line-by-line).
- [x] `scorer.ts`/`baseline.ts`/`report.ts` wired for `ruleRelevanceRate`/`ruleNoiseRate`, same pattern as `falsePositiveRate`.
- [x] `pnpm bench`: existing metrics (extraction recall/precision, hitRate, confirmationRate, falsePositiveRate — overall + per-persona) print `0.0pp` vs `bench/baseline.json` (unchanged, not regenerated). New rule metrics print real day-one numbers with `(no baseline)`.
- [x] Determinism: two consecutive `pnpm bench` runs byte-identical (existing hard assertion), still passes with rules wired in.
- [x] Host-simulation suite (`src/tests/host-simulation.test.ts`) covers, end-to-end through `attend()`/`iranti_write_rule`: (i) write → relevant situation surfaces it ranked within budget; (ii) unrelated situation → not injected; (iii) deactivated → not injected; (iv) cross-project leak check (project A rule never in project B); (v) restart persistence (module-reset pattern, `persistence.test.ts` style).
- [x] `pnpm typecheck` (tsc) and `pnpm lint` exit 0.
- [x] All named gate suites green on PGlite: new rules-relevance suite (10/10), host-simulation suite (3/3), `aliases` 17/17, `projects-isolation` 16/16, `extractor` 27/27, `mcp-tools` 53/53 (up from 51 — 2 new situational-relevance cases added, additive), `facts` 33/33, `it-runs` 1/1.

## 8. Deltas from the master PRD

None. Standing rules/preferences are explicitly named in the master PRD as the product's #1 feature; this phase makes an already-built primitive (`iranti_write_rule` / `getRulesForAttend`) behave the way that feature was always meant to — situationally, not as an unconditional dump. No documented `attend`/`write_rule` behavior is removed; the change is a strictly-narrower injection set under new conditions (message present + rule below critical priority), with full backward compatibility for the no-message path.

## 9. Risks & open questions

- **Extractor-to-rule auto-promotion is a real, named gap this PRD does NOT close.** The corpus's own gold rule-shaped sentences ("Never use SELECT *...", "always add an aria-label...") are captured as `preference:*` facts (or missed entirely, per the messy persona's documented `constraint:export-script-fridays` miss) — never as `rules` table rows, because no bridge exists from "detected preference/constraint sentence" to `writeRule`. This PRD's `ruleProbes` therefore seed rules directly via `writeRule` (bypassing the extractor) rather than relying on the transcript's existing rule-shaped sentences to become real rules automatically. Closing this gap (teaching the extractor, or a new heuristic pass, to promote high-confidence imperative sentences into `rules` rows) is a natural Layer 0e candidate — flagged here so it isn't silently assumed solved.
- **Token-overlap relevance can both under- and over-fire on paraphrase.** A rule "never use SELECT * in reporting queries" will not fire on "can I just grab every column from the report table" (zero shared tokens) — a real limitation of G1's determinism constraint, same class of gap as Layer 0c's alias paraphrase miss. Accepted as an honest, explained limitation rather than reaching for embeddings.
- **Budget interacts with priority in a way that could starve situational rules on a project with many critical (>=100) rules.** If a project accumulates 5+ priority-100 rules, `MAX_RULES_PER_ATTEND = 5` means a genuinely relevant lower-priority rule never gets injected. Accepted for Layer 0d (5 is a starting default, not empirically tuned); flagged as a tuning question for real usage data.
- **No rule supersession/correction primitive beyond deactivate+rewrite (D9).** Matches existing `rules.ts` posture; not a regression, but an already-known limitation now explicitly re-flagged in this PRD's scope review.
- **`ruleNoiseRate`'s honesty depends on corpus authorship quality**, exactly like `falsePositiveRate`'s did — a negative rule probe that accidentally shares a token with a seeded rule's text would produce a false noise reading. Each negative rule probe's wording is deliberately checked against every seeded rule's text for zero token overlap at authoring time (documented in the probe's `note`).
- **The original day-one `ruleRelevanceRate` of 100% was a probe-authorship artifact (review finding, fixed).** Every initially-authored "paraphrase" probe retained at least one exact keyword from its rule's text, so the metric measured "does keyword overlap work when keywords overlap" — near-tautological. The review added one genuinely low-overlap, realistic positive probe per persona (marked `HONEST-CAPABILITY PROBE` in the corpus); three of the four are expected to MISS today, dropping the reported rate to its honest value. That lower number is the real day-one capability of token-overlap relevance; a future deterministic synonym/vocabulary layer closes it as a visible bench delta, exactly like entity resolution did for alias probes.
- **`tokenizeMessage`'s length>=3 filter silently drops 2-character tokens (S3, PR, UI, CI, ID) from BOTH the message and the rule text** — a rule authored around a short codename ("always use presigned URLs for S3") can never match via that token itself and only fires by accidental overlap on other words (review finding). Not changed in this branch: the tokenizer is shared with fact relevance scoring, so lowering the floor is a cross-cutting change that must be measured against the whole bench, not patched ad hoc. Tracked as follow-up RULE-1 in docs/backlog.md.
- **The `closeDb()`-after-`attend()` fire-and-forget race is real, pre-existing, and only worked around, not fixed** (300ms grace periods in this branch's new tests + mcp-tools teardown; root cause: attend's detached post-response chain vs single-connection PGlite teardown leaves an in-flight query promise pending FOREVER). A real host that tears down immediately after a turn can hang. Tracked as follow-up RULE-2 (teardown should await/cancel in-flight chains) in docs/backlog.md.

## 10. Verification

- **Unit:** `scoreRuleRelevance`/relevance-gate function against hand-built rule+message pairs (overlap fires, no-overlap suppresses, critical-priority bypasses, no-message returns unfiltered).
- **Integration:** `getRulesForAttend` with/without message, budget enforcement, existing 5 call sites unchanged.
- **Adversarial:** cross-project rule isolation extended into the host-simulation suite (project A rule never fires in project B, situationally or otherwise).
- **Efficacy gate:** `pnpm bench` before/after table — existing metrics `0.0pp`, new `ruleRelevanceRate`/`ruleNoiseRate` printing honest day-one values (see build report).
- **Scripted host-simulation:** full multi-turn lifecycle (write, relevant surface, irrelevant suppress, deactivate, cross-project, restart) through the real `attend()`/`iranti_write_rule` path, module-reset restart pattern from `persistence.test.ts`.
- **Regression:** `aliases` 17/17, `projects-isolation` 16/16, `extractor` 27/27, `mcp-tools` 51/51, `facts` 33/33, `it-runs` 1/1, all green on PGlite; `tsc`/`lint` 0.

## Changelog
- 2026-07-03 — proposed
- 2026-07-03 — accepted (pre-authorized by the overnight mandate — rules & preferences enforcement is the product owner's #1 feature; PRD written and committed before any implementation code per the PRD-first process rule)
- 2026-07-03 — shipped (branch `feat/rules-enforcement`, commits ddf1f79..4c23dca). Day-one bench: `ruleRelevanceRate` 100% (12/12), `ruleNoiseRate` 0% (0/8), both `(no baseline)` as expected for a new metric; every pre-existing metric 0.0pp vs `bench/baseline.json` (untouched). Found and fixed a real hang while building the host-simulation suite: `closeDb()` called immediately after `attend()` without a grace period raced attend's fire-and-forget post-response chain on PGlite's single connection, leaving a query promise pending forever instead of rejecting — fixed with the same 300ms grace period `harness/ingest.ts`/`projects-isolation.test.ts` already use. `mcp-tools.test.ts` grew from 51 to 53 tests (2 new attend()-level situational-relevance cases, additive, not a regression).
