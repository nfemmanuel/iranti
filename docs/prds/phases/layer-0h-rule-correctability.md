# PRD: Layer 0h — Rule & Alias Correctability (MCP surface)

**Status:** proposed
**Phase:** Layer 0h (YC foundation track) · **Date:** 2026-07-04 · **Author:** NF + Claude
**Related:** dogfood review `docs/reviews/2026-07-04-dogfood-iranti-next.md` (check 6 unrunnable leg; fix-list item 3), Layer 0d PRD (rules enforcement), Layer 0c PRD (aliases), Layer 0 PRD §11 (project scoping; the F3 UUID-leak precedent), master PRD G1 (correctable) and "transparent and auditable".

---

## 1. Summary

Rules are additive by design and never decay — but the MCP surface exposes only `iranti_write_rule`. There is no way for a host (or the user through the host) to see what rules exist or to retire one: the library's `deactivateRule` is unexposed, and `iranti_archive` correctly refuses rule ids. The dogfood eval could not run the "deactivate → re-trigger → silent" leg of the rules check at all. The same asymmetry holds for aliases (learnable, never listable/archivable via MCP). This phase adds four thin, project-scoped tools: `iranti_rules_list`, `iranti_rule_deactivate`, `iranti_aliases_list`, `iranti_alias_archive` — closing the G1 correctability gap on NF's #1 feature with zero schema change.

## 2. Problem & motivation

Dogfood check 6: the rule relevance engine passed surface + noise perfectly, but the correction lifecycle is unreachable — *"a mistaken or stale rule fires forever and duplicates accumulate with no recourse."* First bad rule a real user writes, they hit this. The master PRD is explicit: *"it must be possible to inspect what has been stored, understand why it was stored, and correct it when it is wrong. A memory system that operates with no recourse is a liability."* Facts have the full loop (search/query/history/archive); rules and aliases have write-only surfaces.

**A trust-bug trap discovered during grounding:** `rules.ts`'s `deactivateRule(ruleId)` updates by raw id with **no tenant/project filter**. Exposing it as-is would let any project deactivate any other project's rule by UUID — the exact write-side twin of the Layer 0 F3 fact-UUID leak that was treated as an automatic gauntlet failure. The tool must scope the mutation, and this PRD also hardens the library function itself.

## 3. Goals & non-goals

**Goals**
- List active rules / aliases for the current project scope (id, text/alias, priority/target, entity, active flag, timestamps) so "what is governing me right now?" is answerable.
- Deactivate a rule / archive an alias by id, project-boundary-checked, honest `deactivated: false` on unknown-or-out-of-scope (indistinguishable, matching `iranti_archive`'s posture verbatim).
- Deactivation is reversible in the database (isActive flag; never hard-delete) — G1.
- The dogfood scorecard's deactivate→silent leg becomes runnable end-to-end.

**Non-goals**
- Rule editing/supersession primitives (deactivate + rewrite remains the documented posture, Layer 0d D9).
- Rule reactivation tool (flag it in §9; the flag flip exists at DB level, the surface can follow demand).
- Alias re-pointing (re-learning the same alias text already upserts the binding — Layer 0c).
- Any change to triggering/relevance logic.

## 4. Scope

**In**
- `src/library/rules.ts`: `deactivateRule(ruleId, tenantId?, project?)` gains scope filters and returns `boolean` (rows-affected honesty); `listRulesForProject(tenantId?, project?)` (active-only by default, `includeInactive` opt-in for audit).
- `src/library/aliases.ts`: confirm/align `listAliasesForEntity` + `archiveAlias` scoping (archiveAlias is already project-boundary-checked per Layer 0c D8 — verify, don't rebuild).
- `src/mcp/tools/rules.ts` (new): `rulesList`, `ruleDeactivate` handlers using `ensureContext` + `getEffectiveProjectIds`, mirroring `archive.ts`'s shape exactly.
- `src/mcp/tools/entity-aliases.ts` (new): list/archive handlers for entity aliases (NOT `aliases.ts`, which is the registered OpenAI tool-name-alias module — see D5).
- `src/mcp/register.ts`: register all four tools.
- Adversarial tests: project A cannot list or deactivate project B's rules/aliases, by id or otherwise; unknown-vs-out-of-scope indistinguishable.
- Host-simulation extension: write rule → triggers → **deactivate via the new tool** → re-trigger → silent → restart → still silent.

**Out (deferred)**
- `iranti_rule_reactivate` / undo tooling (§9).
- Rules history (rules table has no archive-history mechanism like facts; deactivation timestamps via `updatedAt` suffice for now — flagged §9).

## 5. Design decisions & rationale

- **D1 — Fix `deactivateRule` at the library layer, not just the tool layer.** Add `tenantId`/`project` filter params (defaulted like every sibling) and return whether a row was affected. *Why:* a scoped tool over an unscoped library function leaves a loaded footgun for the next internal caller; Layer 0's precedent (`getFactById`'s guard) fixed the library. *Rejected:* tool-layer-only check via a prior `getRuleById` + compare — TOCTOU-shaped and duplicates policy.
- **D2 — Mutation scope = the effective/combined project set, verbatim parity with `archiveFact`'s live production semantics.** PRD-review verification (not an open question): `archiveFact(factId, project?)` checks the fact's project against whatever set the caller passes, and its only production caller (`archive.ts`) passes `getEffectiveProjectIds(ctx.project.id)` — so a fact visible through combine IS archivable today. `iranti_rule_deactivate` and `iranti_alias_archive` therefore also scope their mutation to the effective set. Consistency with the fact surface beats a bespoke rule; divergence between "which facts can I archive" and "which rules can I deactivate" would be a protocol surprise. A parity test asserts both surfaces accept an in-combine id and both refuse an out-of-scope id identically.
- **D3 — `rulesList` returns ids.** Deactivation needs a handle; the attend response deliberately omits rule ids (hosts shouldn't need them per-turn). The list tool is the audit surface, so it carries `id`, `entity`, `text`, `priority`, `isActive`, `createdAt`, `updatedAt`, `source`-equivalents. *Rejected:* adding rule ids to `AttendResult.rules[]` — bloats every turn's payload for a rare operation (token economy, dogfood DX finding).
- **D4 — Honest result shape copied from `iranti_archive`:** `{ deactivated: boolean, ruleId, reason }`, out-of-scope message byte-compatible in structure with the fact tool's ("No active rule with that id in your project scope (unknown id, already inactive, or outside this project)."). Unknown vs out-of-scope indistinguishable — same trust rationale.
- **D5 — Alias tools ride along, in a NEW file `src/mcp/tools/entity-aliases.ts`.** Same gap, same shape, library functions already exist and are already project-scoped (`listAliasesForEntity`, `archiveAlias` — verified); the marginal cost is two thin wrappers + tests, and check 4's caveat showed aliases will need pruning once bare-path learning (AX-9) widens what gets learned. PRD-review correction: the existing `src/mcp/tools/aliases.ts` is NOT available to extend — it is already registered for an unrelated purpose (OpenAI deep-research `search`/`fetch` tool-NAME aliases, gated behind `IRANTI_EXPOSE_OPENAI_ALIASES`). Bolting entity-alias handlers onto that file would conflate two concepts and risk the new tools inheriting that env gate. *Rejected:* extending `aliases.ts` (naming collision), and deferring aliases again — that deferral is exactly how the gap shipped.

## 6. Schema / API changes

No tables, no columns, no migrations. Four new MCP tools:
- `iranti_rules_list` → `{ rules: [{ id, entity, text, priority, isActive, createdAt, updatedAt }] }` (current project scope; `includeInactive?: boolean`).
- `iranti_rule_deactivate` `{ ruleId }` → `{ deactivated, ruleId, reason }`.
- `iranti_aliases_list` `{ entityType?, entityId? }` → `{ aliases: [{ id, entity, alias, rawAlias, factKey, isActive, createdAt }] }` (defaults to all entities in current project).
- `iranti_alias_archive` `{ aliasId }` → `{ archived, aliasId, reason }`.
`deactivateRule` library signature change (additive params + boolean return) — internal callers updated in the same commit.

## 7. Acceptance criteria

- [ ] This PRD accepted before implementation code.
- [ ] Four tools registered and callable; shapes as §6.
- [ ] `deactivateRule` scoped at the library layer; returns false (no row) for out-of-scope/unknown ids; parity-with-`archiveFact` semantics pinned by test (D2).
- [ ] Adversarial: project A cannot list, deactivate, or archive project B's rules/aliases by any input, including raw UUIDs; messages indistinguishable from unknown-id.
- [ ] Host-simulation: rule surfaces on relevant turn → `iranti_rule_deactivate` → same trigger message is silent → module-reset restart → still silent.
- [ ] Alias: learn → list shows it → archive → nickname query no longer resolves (attend integration).
- [ ] New adversarial test coverage exists for all four tools (cross-project by-id and by-list; parity test per D2) — not just the untouched legacy suite.
- [ ] `pnpm bench`: all metrics 0.0pp (this phase touches no extraction/scoring path); determinism holds.
- [ ] Full suite + `tsc` + `lint` green; `projects-isolation.test.ts` untouched and green.

## 8. Deltas from the master PRD

None — implements the master PRD's "transparent and auditable / correct it when it is wrong" for the two surfaces that lacked it.

## 9. Risks & open questions

- **No reactivation tool this phase.** A mistaken deactivation is recoverable only at the DB level (flag flip). Accepted: wrong-rule-firing-forever is the live pain; wrong-deactivation is speculative. Follow-up named: `iranti_rule_reactivate`.
- **Rules lack value-history** (no rules_archive table). Deactivate+rewrite loses the old text to everything except the inactive row itself. Acceptable now because inactive rows are never deleted; a future rules-history follow-up should NOT be solved by this phase quietly.
- **List tools return ids — ids in host context.** The Layer 0 leak class makes ids sensitive-ish; mitigated because every id-accepting surface is scope-guarded (that's this PRD's core), and ids were already visible in write-tool results.
- **Tool-count creep** (16 → 20 tools). The parked token-economy discussion may later consolidate audit tools behind one `iranti_inspect` surface; out of scope here, noted so the redesign conversation sees it.

## 10. Verification

Unit (scoped deactivate/list), adversarial cross-project suite mirroring `projects-isolation.test.ts` patterns, host-simulation lifecycle extension, bench 0.0pp determinism, full regression.

## Changelog
- 2026-07-04 — proposed (from dogfood review check 6; NF mandate "document, review, implement, review, test, report")
- 2026-07-04 — PRD review (fresh-eyes, verdict ACCEPT-WITH-EDITS): D2 resolved (mutation scope = effective set, archiveFact's verified production semantics); D5 corrected (new entity-aliases.ts — tools/aliases.ts is the registered OpenAI tool-name-alias module).
- 2026-07-04 — implemented on `feat/dogfood-remediation-1` (3c637aee; pending NF merge). Four tools registered; deactivateRule scoped at the library layer; 9 new tests incl. archiveFact parity and the full check-6 deactivate→silent lifecycle; bench 0.0pp. Code-review gauntlet verdict: MERGE-READY, no findings.
