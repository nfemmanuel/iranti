# PRD: Layer 0c — Entity Resolution (the "textbook" fix)

**Status:** accepted
**Phase:** Layer 0c (YC foundation track) · **Date:** 2026-07-03 · **Author:** NF + Claude
**Related:** master PRD (memory-quality claims), Layer 0 PRD (`layer-0-foundation.md` — project scoping this feature must respect), Layer 0b PRD (`layer-0b-harness.md` — the measurement instrument this PRD's efficacy gate runs on). Named product gap referenced directly in the overnight mandate.

---

## 1. Summary

When a user refers to something by a nickname instead of its real name — "the figma file," "the reconciliation doc," "the widget" — iranti today cannot find the fact that nickname points to. This PRD adds durable, project-scoped **alias links**: an alias is learned ONCE from an explicit declarative statement ("everyone calls it 'the figma file'"), stored as a link from the alias text to the fact it names, and applied at every retrieval thereafter via exact lookup. This closes the single sharpest gap the Layer 0b measurement harness exists to expose: four alias-phrased probes across the corpus score `rank: null` today; this feature is judged directly by whether they flip to hits.

## 2. Problem & motivation

Real conversations are full of nicknames. A team calls a Figma link "the figma file," a runbook URL "the sync wiki page," a project "the widget." iranti's retrieval (`readRelevantFactsByEntity`, keyword-overlap scoring) has no way to connect the nickname string to the fact it refers to — the nickname shares zero tokens with the URL or path it names, so keyword scoring always misses. This is not a tuning problem; it is a missing capability. The Layer 0b harness's `bench/corpus/*.json` gold facts document exactly this, persona by persona:

- `frontend-dev`: `alias:the-figma-file` → the Figma URL, from *"See <url> for the latest mocks — everyone just calls it 'the figma file' in Slack."*
- `backend-api-dev`: `alias:the-reconciliation-doc` → the GitHub doc URL, from *"See <url> ... I keep calling it 'the reconciliation doc' in standup, same thing."*
- `data-ml-person`: `alias:the-dashboard-run` → the wandb URL, from *"See <url> ... I just call it 'the dashboard run' when I mention it in meetings."*
- `messy-conversationalist`: `alias:the-sync-wiki-page` → the runbook URL, from *"...has the full runbook ... some people call it 'the sync wiki page' too."* (compounded with `alias:the-widget`, an entity-level nickname for the whole project — the sharpest case in the corpus, see §3 non-goals).

All four are probed (`"Where's the figma file?"`, `"Where's the reconciliation doc?"`, `"Where's the dashboard run?"`, `"Where's the widget's sync job documented?"`) and all four score `rank: null` in `bench/baseline.json` today. This PRD's acceptance bar is that all four flip to `hit: true` (ideally `confirmed: true`, rank 1) without moving any other metric except where explained.

## 3. Goals & non-goals

**Goals**
- Learn an alias deterministically from an explicit declarative signal in a message ("X calls it 'Y'", "aka", quoted-nickname-adjacent-to-artifact), the same heuristic-regex approach the existing extractor already uses for decisions/preferences/constraints.
- Store the alias as a durable link: `alias text → the fact it resolves to`, scoped to `(tenantId, project, entityType, entityId)` exactly like every other Layer 0 table.
- Apply the alias at retrieval time via **exact, deterministic** stored-alias lookup — never fuzzy/embedding similarity — so an alias-phrased query resolves to its target fact every time, forever, once learned.
- Aliases are correctable: listable and archivable (deactivate, never hard-deleted), matching the `rules`/`facts` precedent (G1).
- Close the alias misses in the Layer 0b harness that are reachable under a strictly deterministic, exact-match resolution (G1) without regressing any other metric (or explain every metric that moves). Concretely: `alias:the-figma-file`, `alias:the-reconciliation-doc`, `alias:the-dashboard-run` — each probed with a query that contains the learned alias phrase verbatim. `alias:the-sync-wiki-page` is a fourth, DELIBERATELY compounded case (see §9) whose probe text never contains the literal alias phrase; whether it flips is an open question resolved during build, not a pre-committed acceptance bar (forcing it to flip would require paraphrase/fuzzy matching, which G1 forbids).

**Non-goals**
- **Entity-level aliasing** ("the widget" naming the whole `internal-tools-dashboard` project, "the dashboard" naming `dashboard-redesign`). Both are gold-labeled in the corpus (`alias:the-widget`, `alias:the-dashboard`) but **neither is wired to a probe** — the harness's own gold notes say so explicitly ("not separately probed since entityHints are supplied explicitly by every probe in this harness"). Every probe in the corpus already supplies the correct `entityHints`, so resolving "which project is 'the widget'" is not required to flip any bench number. Building it now would be scope creep against an untested path. Flagged as a named follow-up (§9).
- Fuzzy/semantic alias matching (embedding similarity, LLM-based nickname inference). G1 in the overnight mandate requires determinism; this is a hard constraint, not a preference.
- Cross-project alias resolution or any form of alias "combine" beyond what `getEffectiveProjectIds` already provides for facts. An alias learned in project A must not resolve in project B unless the two are already combined (Layer 0's existing mechanism) — reusing that mechanism, not building a new one.
- Learning aliases from the LLM extractor path (`LocalLlmExtractor`). This is a heuristic-only feature in Layer 0c, matching the harness's own `IRANTI_EXTRACTOR=heuristic` determinism requirement. LLM-assisted alias learning is a future phase if `local` mode ever needs it.
- Rewriting or improving the underlying artifact extractor's precision/recall (the file-path-in-prose gaps, the `was X not Y` correction gap, etc., documented elsewhere in the corpus). Out of scope here.

## 4. Scope

**In**
- Schema: new table `entity_aliases` (migration `0014`), `project`-scoped like `facts`/`rules`.
- `src/library/aliases.ts`: `learnAlias`, `resolveAlias`, `listAliasesForEntity`, `archiveAlias` — mirrors the shape of `rules.ts`/`facts.ts` (project filter, tenant default, never hard-delete).
- Alias-learning heuristic pattern(s) added to the extraction layer, gated so they only fire on the same explicit, low-ambiguity phrasing the rest of `HeuristicExtractor` uses.
- Retrieval-side application in `iranti_attend`'s read path: before/alongside `readRelevantFactsByEntity`, check whether the message contains a known alias for the entity in scope, and if so, resolve it to its target fact and ensure that fact is included (and ranked competitively) in the returned set.
- Adversarial cross-project alias tests (an alias learned in project A must not resolve in project B).
- Bench run showing the reachable alias probes flip, with every other metric delta (including the compounded case, whichever way it lands) explained.

**Out (deferred)**
- Entity-level alias resolution ("the widget" → project id) — deferred to a future phase once a probe actually exercises entity-hint-free queries. Owner: whoever picks up the harness's own documented gap next.
- `iranti_alias_*` MCP tools (explicit user-facing alias management, e.g. "forget that alias") — deferred; `archiveAlias`/`listAliasesForEntity` exist at the library layer now so the MCP surface is a thin follow-up, not a redesign.
- LLM-assisted alias learning — deferred to whenever `IRANTI_EXTRACTOR=local` alias quality becomes a priority.

## 5. Design decisions & rationale

- **D1 — Alias resolves to a FACT, not just an entity.** The corpus's alias gold facts all point at a specific fact's value (a URL), not merely "which entity is this." *Why:* that's what the probes actually test ("Where's the figma file?" expects the URL fact). *Rejected:* alias → entityId only, requiring a second retrieval pass to find "the right fact within that entity" — this doesn't match the corpus's shape and would still miss the probe (the entity is already given via `entityHints`; the missing link is entity+alias → *which fact*).
- **D2 — Alias learning binds to the most-recently-extracted artifact in the SAME message.** All four probed cases share one shape: a URL appears earlier in the sentence, then the sentence names a nickname for "it" ("everyone calls it 'the figma file'"). The heuristic captures the quoted nickname and binds it to the artifact fact (`shared_url:*` / `referenced_file:*`) extracted from the same message via the existing deterministic `extractArtifacts()` pass in the same `attend()` write turn. *Why deterministic:* both signals (the nickname pattern match, and "the most recent artifact extracted from this exact message") are pure functions of the message text — same input, same output, always. *Rejected:* binding to "the most recent fact of any kind written to this entity" (not just artifacts from this message) — that is order-dependent on unrelated prior writes and would silently mis-bind an alias to whatever fact happened to be written last, violating determinism in a subtler way (same message, different history → different alias target).
- **D3 — Heuristic patterns, not fuzzy matching (G1 hard constraint).** New regex patterns are added to a dedicated `ALIAS_PATTERNS` set, following the exact shape of `DECISION_PATTERNS`/`PREFERENCE_PATTERNS` in `src/extract/index.ts`. Patterns matched: `(?:everyone|some people|people)\s+(?:call|calls)\s+it\s+['"](.+?)['"]`, `\bI\s+(?:keep\s+|just\s+)?call\s+it\s+['"](.+?)['"]`, `\bwe(?:'re| are)\s+calling\s+it\s+['"](.+?)['"]`, and an explicit `\baka\s+['"]?(.+?)['"]?(?:[.,;]|$)` fallback for the common "aka X" shorthand (not present in the corpus but named explicitly in the overnight mandate's signal list). Application at read time is an exact, case/whitespace-normalized string lookup against the stored alias — never a similarity score. *Rejected:* embedding cosine-similarity between query text and stored aliases — non-deterministic in the sense that matters here (model/version drift changes results over time) and explicitly forbidden by the mandate's G1.
- **D4 — New table, not an alias column on `facts`.** A fact can have zero, one, or many aliases over time (and an alias could — in a future phase — apply across multiple facts, e.g. a rename). Modeling this as a separate `entity_aliases` table (alias → target fact id) keeps `facts` schema-stable and matches G1's "correctable, never hard-deleted" requirement independently of the target fact's own lifecycle (archiving the alias must not require touching or archiving the fact it points to, and vice versa). *Rejected:* a JSON `aliases: string[]` column on `facts` — harder to index for exact lookup, no natural place for `source`/`confidence`/`isActive` per-alias metadata, and couples alias lifecycle to fact row lifecycle.
- **D5 — Project-scoped exactly like `facts`/`rules`/`knowledge_edges`.** `entity_aliases` gets `tenantId text NOT NULL DEFAULT 'default'` and `project text NOT NULL DEFAULT 'default'`, included in the uniqueness constraint, filtered by a `projectFilter`-style helper identical in shape to `facts.ts`'s. *Why:* Layer 0 (D6/D7 of that PRD) established project as a dedicated scope dimension that every retrieval-adjacent table must carry; an alias link learned in one folder must not silently resolve in another (that's exactly the adversarial cross-project leak class Layer 0's own test suite targets). *Rejected:* omitting project scoping on the theory that "aliases are just vocabulary, not secrets" — an alias's TARGET is a specific fact's id, which may itself be project-private; resolving an alias across the project boundary would leak the existence and content of that fact, which is precisely what `getFactById`'s project-scoped guard (Layer 0, "review-gauntlet BLOCKER" fix) was built to prevent for direct id lookups. An alias must not become a side-door around that guard.
- **D6 — Retrieval applies the alias via an explicit resolve step in `attend()`'s read path, before ranking.** When a message contains a phrase matching a stored alias for one of the entity hints in scope, `resolveAlias` looks up the target fact id (project-scoped) and — if it's live and in scope — the read path guarantees that fact is present in the ranked candidate set (injected ahead of/alongside the keyword-scored candidates, not merely hoped to score well on keyword overlap, since by definition an alias shares no tokens with its target). *Why "guarantee inclusion" rather than "boost score":* the whole point of alias resolution is that keyword scoring structurally cannot find the fact — a score boost that still competes against the existing ranked-and-capped candidate list only fixes the problem probabilistically. An explicit, deterministic inclusion (deduped against what keyword scoring already found) is the only way to guarantee the probe's expected fact appears, matching G1. *Rejected:* folding alias matches into `scoreRelevance`'s token-overlap scorer as extra synthetic tokens — still probabilistic (competes with the `limit`/budget cap) and duplicates the "exact deterministic lookup" requirement inside a function whose whole design is fuzzy keyword overlap.
- **D7 — Alias lookup is scoped per entity hint, matching how `readRelevantFactsByEntity` is already called per hint in `attend()`.** No new "search across all entities for a matching alias" surface — that would be a different (and unscoped) capability. The alias table is keyed by `(project, entityType, entityId, alias)`, and resolution only ever asks "does entity X have an alias matching this message," matching the existing per-hint retrieval loop.
- **D8 — Never hard-deleted (G1).** `archiveAlias(id)` sets `isActive = false`; there is no delete path, matching `rules.deactivateRule` and `facts.archiveFact`'s posture exactly.

## 6. Schema / API changes

**New table: `entity_aliases`** (migration `0014`)

```
id            uuid PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id     text NOT NULL DEFAULT 'default'
project       text NOT NULL DEFAULT 'default'
entity_type   text NOT NULL
entity_id     text NOT NULL
alias         text NOT NULL   -- normalized (lowercased, whitespace-collapsed) alias phrase
raw_alias     text NOT NULL   -- original phrasing, for provenance/display
fact_key      text NOT NULL   -- normalized key of the fact this alias resolves to
source        text NOT NULL   -- "extractor_heuristic" (Layer 0c only writes this value)
confidence    real NOT NULL DEFAULT 0.85
is_active     boolean NOT NULL DEFAULT true
created_at    timestamptz NOT NULL DEFAULT now()
updated_at    timestamptz NOT NULL DEFAULT now()

UNIQUE (tenant_id, project, entity_type, entity_id, alias)   -- one target per alias per entity
INDEX (tenant_id, project, entity_type, entity_id, is_active) -- resolve-path lookup
```

Design note: `fact_key` (not `fact_id`) is the stored pointer — resolving to "the live fact for this entity+key" rather than a frozen row id means an alias survives its target fact being superseded (a new value written to the same key) without needing to be re-learned; this matches how every other part of iranti treats `(entityType, entityId, key)` as the durable identity and the fact row itself as the current value. Re-learning the *same* alias text for the same entity is an idempotent upsert (reactivates + updates `fact_key`/`raw_alias` if the binding changed), matching `writeFact`'s upsert posture.

**New library module: `src/library/aliases.ts`**
- `learnAlias(input: { entityType, entityId, alias, rawAlias, factKey, source, confidence?, tenantId?, project? }): Promise<EntityAlias>` — upsert on `(tenantId, project, entityType, entityId, normalizedAlias)`.
- `resolveAlias(entityType, entityId, messageOrAlias, tenantId?, project?): Promise<string | undefined>` — returns the target `fact_key` if the message contains (or equals) a known active alias for this entity, else `undefined`. Exact/normalized substring match only (D3).
- `listAliasesForEntity(entityType, entityId, tenantId?, project?): Promise<EntityAlias[]>` — for correctability/audit.
- `archiveAlias(id, project?): Promise<boolean>` — sets `isActive = false`, project-boundary-checked like `archiveFact`.

**Extraction (`src/extract/index.ts`):** new `ALIAS_PATTERNS`, a new `extractAliases(message, extractedArtifacts)` step inside `HeuristicExtractor.extract` (or a sibling function called from `attend.ts`'s write side) that binds a matched quoted-nickname to the most-recently-extracted artifact fact from the *same* message.

**Retrieval (`src/mcp/tools/attend.ts`):** in the per-hint read loop, before/alongside `readRelevantFactsByEntity`, call `resolveAlias(hint.entityType, hint.entityId, input.message, "default", effectiveProjectIds)`; if it resolves, fetch that fact (`findFact`) and ensure it is present in the ranked candidate list for that hint (deduped by id against what keyword scoring already returned).

**No breaking changes** to any existing tool signature, response shape, or table.

## 7. Acceptance criteria

- [ ] `docs/prds/phases/layer-0c-entity-resolution.md` (this file) exists, accepted, committed before any code.
- [ ] Migration `0014` adds `entity_aliases`, applies cleanly on both PGlite (transactional auto-migrate) and Postgres.
- [ ] `src/library/aliases.ts` implements learn/resolve/list/archive, project-scoped exactly like `facts.ts`/`rules.ts`.
- [ ] Alias-learning heuristic fires deterministically on the corpus's real phrasings ("X calls it 'Y'", "aka Y") and binds to the correct in-message artifact.
- [ ] `attend()`'s read path applies a resolved alias deterministically, guaranteeing the target fact is present in the returned set.
- [ ] Adversarial cross-project alias test: an alias learned in project A does not resolve in project B (isolated), and DOES resolve once A+B are combined via the existing `combineProjects` mechanism — a leak is an automatic failure.
- [x] `pnpm bench`: the 3 non-compounded probed alias cases (`alias:the-figma-file`, `alias:the-reconciliation-doc`, `alias:the-dashboard-run`) flip from `hit: false` to `hit: true` (confirmed at rank 1 — `confirmed: true` — in all 3). `bench/baseline.json` is left untouched (not regenerated) so the run visibly prints the deltas.
- [ ] `alias:the-sync-wiki-page` (the compounded case, §9): does NOT flip under strict exact-substring alias resolution — the probe's query text ("Where's the widget's sync job documented?") never contains the literal learned alias phrase ("the sync wiki page"), so there is nothing for a deterministic lookup to match. Flagged, not silently left broken: see the build report for the full trace (the target fact is in fact retrieved and ranked #1 today via the PRE-EXISTING keyword-overlap scorer's incidental "sync"/"job" token match — it just surfaces under its own `shared-url:*` key, not the gold's `alias:the-sync-wiki-page` key, because no alias phrase match fired to synthesize that key).
- [ ] Determinism: two consecutive `pnpm bench` runs are byte-identical (existing harness assertion), still passes with alias resolution active.
- [ ] `bench/corpus/*.json` byte-unchanged (`git diff --stat` confirms zero changes) — the corpus is gold, not tuned to.
- [ ] `pnpm typecheck` (tsc) and `pnpm lint` exit 0.
- [ ] `projects-isolation.test.ts` (16/16) untouched and green.
- [ ] New alias unit + integration tests green; `facts`/`mcp-tools`/`graph` spot suites green on PGlite; `it-runs` 1/1.

## 8. Deltas from the master PRD

None. Entity resolution is explicitly named in the master PRD's problem statement (the "textbook" example) as a capability iranti must eventually have; this phase delivers a first, deterministic, heuristic-only slice of it. No documented `attend`/`write` behavior is removed or changed in an incompatible way — this is additive.

## 9. Risks & open questions

- **Entity-level alias resolution is a known, deliberately deferred gap.** `alias:the-widget` and `alias:the-dashboard` remain unresolved after this phase (by design — see §3 non-goals) because no probe in the current corpus exercises entity-hint-free alias resolution. If a future probe or real usage needs "which project is 'the widget'" without an explicit hint, that is a distinct capability (alias → entityId, searched across entities in scope rather than within one given entity) and should get its own PRD delta rather than being silently bolted on here.
- **Alias-to-artifact binding is same-message-only.** If a user names an artifact in one message and gives it a nickname three messages later ("by the way, that URL from earlier — call it 'the doc'"), this phase will not learn the alias; the heuristic only binds within a single message's extraction pass (D2). This is a real, named limitation, consistent with the rest of `HeuristicExtractor`'s per-message, no-cross-turn-memory design.
- **Multiple artifacts in one message.** If a message contains two URLs and one nickname, the heuristic binds to the most-recently-extracted artifact before the nickname phrase (order of appearance) — not present in the current corpus, but worth a unit test to pin the behavior rather than leave it implicit.
- **Confidence value (0.85) matches the existing heuristic extractor's constant** — not separately tuned; revisit if alias false-positive learning ever becomes observable at scale.
- **`fact_key`-based resolution (not `fact_id`)** means an alias silently "follows" a fact through supersession (new value, same key) but does NOT survive the fact being archived-and-recreated under a different key. Accepted: matches how every other durable reference in the codebase (rules, checkpoints) already treats `(entityType, entityId, key)` as the stable identity.
- **The compounded probe (`alias:the-sync-wiki-page`) is a known, deliberately unresolved gap under G1.** Its query ("Where's the widget's sync job documented?") never contains the literal alias phrase ("the sync wiki page") the corpus taught — it's a paraphrase, sharing only the tokens "sync"/"job" with the target fact's VALUE (the URL itself), not with the alias text. An exact-substring resolver (this PRD's design, G1-compliant) structurally cannot match paraphrases; only a fuzzy/semantic layer could, and G1 forbids that. Build-time finding: the target fact is retrieved and ranked #1 regardless, via the PRE-EXISTING keyword-overlap scorer's incidental match on "sync"/"job" in the URL value — it just surfaces under its real `shared-url:*` key rather than the gold's synthesized `alias:the-sync-wiki-page` key, so the harness's strict-key-match scorer still counts it as a miss. This is the sharpest case in the corpus by design (per its own gold note) and is left as an honest, explained miss rather than special-cased.

## 10. Verification

- **Unit:** `ALIAS_PATTERNS` matching against the corpus's real sentences (and near-miss negatives that must NOT match, to catch over-eager patterns); `aliases.ts`'s upsert/resolve/archive semantics against a fresh PGlite store.
- **Integration:** full `attend()` round-trip — write a message containing an artifact + alias phrase, then query with only the alias phrase, confirm the artifact fact is returned and ranked competitively.
- **Adversarial:** cross-project alias isolation and combine/uncombine, mirroring `projects-isolation.test.ts`'s existing pattern.
- **Efficacy gate:** `pnpm bench` before/after table — see the build report for exact numbers; the four probed alias cases must flip to hits with every other metric delta explained line-by-line.
- **Regression:** full existing suite (`it-runs`, `projects-isolation` 16/16, `facts`, `mcp-tools`, `graph`, harness determinism) green on PGlite; `bench/corpus/*.json` and `bench/baseline.json` byte-unchanged per `git diff --stat`.

## Changelog
- 2026-07-03 — proposed
- 2026-07-03 — accepted (pre-authorized by the overnight mandate — entity resolution is the named product gap; PRD written and committed before any implementation code per the PRD-first process rule)
