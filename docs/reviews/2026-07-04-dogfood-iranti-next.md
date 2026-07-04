# Dogfood Review — iranti-next as its own first user

**Date:** 2026-07-04 · **Evaluator:** Claude (Claude Code session, `claude-dogfood` agent) · **Store:** fresh, empty, embedded PGlite (`~/.iranti/db`) via `.mcp.json`'s `iranti-next` entry running `src/mcp/server.ts` from this repo's source
**Method:** the 13-check scorecard from NF's eval brief, run during real work (reading `attend.ts`, `extractor.ts`, `rules.ts`, running the bench). Realistic phrasing throughout; every quoted response is verbatim from the tool. Known-limitation vs bug adjudicated against each PRD's §9.

**Headline:** 8 clean passes — including the four that motivated the rebuild (no-answer honesty, the textbook alias, rules-at-the-right-moment, adversarial project isolation) — plus a byte-deterministic bench matching the morning report exactly. The failures cluster in one place: the **heuristic extraction layer meeting real conversational phrasing**, and one of them produces the exact junk-fact class the project exists to prevent. Nothing found blocks the architecture; two things should be fixed before iranti-next becomes THE iranti.

---

## The 13 verdicts

### 1. Cold first contact — PASS

First-ever attend on the empty store, said as a normal session opener:

> "Starting a working session on the iranti repo — I want to look over the new attend implementation and the benchmark harness today."

Response, in full:

```json
{ "rules": [], "facts": [], "peripheral": [], "checkpoint": null,
  "extracted": [], "alreadyPresent": 0, "corrections": [], "media": [],
  "nextDue": "iranti_attend(phase='post-response') due after response; iranti_attend(phase='mid-turn') available if new entities discovered",
  "projectState": null }
```

No errors, no noise, and the shape is self-explaining as a host: every field I'd later need was already present and typed, and `nextDue` teaches the protocol inline. Night-and-day against old iranti's first contact (see DX section).

### 2. Write → confirm — PARTIAL

Told it three real facts conversationally in one message: a decision ("we decided to keep PGlite as the default database engine — Postgres is opt-in through the IRANTI_DB_ENGINE env var"), a preference ("I prefer every feature to start as a PRD before any code gets written"), and a constraint ("one hard constraint: the bench corpus files under bench/corpus are gold — we never edit them…").

Later asked: *"Remind me — which database engine does this thing boot with by default? I remember we made a call on that."* Result: the decision **was never stored** (only the preference had been extracted — see check 3), so there was nothing to confirm and I had to re-derive the answer from the repo. The system was honest about it — the one fact returned was labeled `matched: false` — but the "confirm, don't discover" bar was missed for that fact.

The positive path, however, works: asking *"how do we start a new feature around here? Is there a process step that comes before writing code?"* returned the stored preference at rank 1:

```json
{ "key": "preference:every-feature-to-start-as-a-prd-before-a",
  "value": "every feature to start as a PRD before any code gets written",
  "matched": true }
```

Judgment: retrieval confirms what extraction stored — the miss is upstream, in extraction recall on natural long sentences (disclosed floor: 74.5%), not in the confirm path.

### 3. Extraction honesty — FAIL (one invented fact; otherwise clean)

Audit of the store after ~20 turns of real use: keys are normalized and categorized (`preference:*`, `decision:*`, `correction:*`, `shared-url:<hash>`, `alias:*`), no accumulation of chatter, dedupe works. Two misses (the PGlite decision, the corpus constraint) traced to a concrete mechanism: **DECISION/CONSTRAINT patterns terminate the capture at `[.,;]` within 80 chars, and the em-dash is not a terminator** — long, dash-punctuated sentences (the way NF actually writes) extract nothing.

But the check is named "nothing invented," and something was invented. My post-response summary — *"Told the user **no** rate limiting **decision is** on record for the HTTP transport"* — hit the bare `\bdecision[:\s]+` pattern and stored:

```json
{ "key": "decision:is-on-record-for-the-http-transport",
  "value": "is on record for the HTTP transport",
  "source": "extractor_heuristic" }
```

The negation was dropped; the store now contained the inverse of reality, harvested from the very turn that tested no-answer honesty. Host-authored summaries say "decision" constantly — this is a repeatable junk generator, and it is precisely the Mem0/ByteRover failure class the thesis targets. The bench's 100% precision is real but its corpus evidently never feeds the extractor a negated sentence containing a category noun. Scored a genuine FAIL, not an expected-limit: no §9 discloses fabrication, only misses ("wrong facts are worse than missing facts" is the module's own header).

### 4. The textbook, literally — PASS

Taught in one natural breath: *"The canonical copy of last night's build write-up is at https://github.com/nfemmanuel/iranti/blob/main/docs/reviews/2026-07-03-overnight-build.md — everyone just calls it 'the morning report'."* Four turns later: *"Can you pull up the morning report? I want to double-check the gauntlet totals in it."* Rank 1:

```json
{ "key": "alias:the-morning-report",
  "value": "https://github.com/nfemmanuel/iranti/blob/main/docs/reviews/2026-07-03-overnight-build.md",
  "source": "iranti_attend_extract", "matched": true }
```

Taught once, resolves thereafter, as an `alias:*` view, matched, rank 1. The exact bar, hit exactly.

**Caveat discovered en route:** my first attempt taught the nickname against the bare repo-relative path `docs/reviews/2026-07-03-overnight-build.md` — and nothing happened. `RELATIVE_PATH_PATTERN` requires a `./` or `../` prefix, so the way developers actually type paths is invisible to `extractArtifacts`, and since `extractAliases` only runs when an artifact was extracted from the same message, the nickname was silently not learned (`extracted: []`, no alias). The textbook fix works for URLs and `./`-prefixed paths only.

### 5. Alias paraphrase ceiling — EXPECTED-LIMIT (disclosed), and the disclosure is accurate

Probe: *"Where's that write-up of everything that got built overnight? I can never find it when I need it."* — never says "morning report." Result: no alias fired, **zero** `matched: true` facts, but the underlying URL fact still surfaced ambiently at rank 2 under its real key `shared-url:be9a602faf2b` with `matched: false`. PRD 0c §9 predicts exactly this (exact-substring resolver structurally cannot match paraphrase; target may still surface via other channels), and Layer 0f's labeling means the host is not lied to about it. Observation matches disclosure precisely.

### 6. Rules: surface when it matters — PASS on surface + noise; the deactivate leg is UNRUNNABLE (gap)

Wrote a rule I actually hold: *"Always run pnpm bench before merging any change that touches extraction or retrieval scoring, and include the metric deltas in the merge commit message."* (priority 50).

- **Trigger turn** (no wording echo): *"I've got a small tweak to the fact ranking logic ready — planning to merge it onto main this afternoon. Anything I should do before it lands?"* → the rule appeared in `rules[]`, alone, at the moment it mattered. NF's #1 pain, working.
- **Noise check:** two unrelated exchanges (a stale README badge; a branch-name aside) → `rules: []` both times. Silent when it should be.
- **Deactivate leg: cannot be performed.** The MCP surface has no rule-deactivation tool and no rule-listing tool — `register.ts` exposes `iranti_write_rule` and nothing else for rules; `iranti_archive` is facts-only and honestly refused the rule's id (`"archived": false — "No active fact with that id…"`). The library's `deactivateRule` exists but no host can reach it. Since rules are additive by design ("writing twice creates two rules"), a mistaken or stale rule fires forever and duplicates accumulate with no recourse. That is a G1-correctability gap on the exact feature that is NF's #1 — flagged as a fix-list item, not scored against the relevance engine, which did its job perfectly.

### 7. No-answer honesty — PASS

Probe (plausible, never decided): *"What did we settle on for rate limiting on the HTTP transport? I remember there being a discussion about it."* Result: ambient context returned, **zero facts with `matched: true`** — the response shape says "nothing here answers that." The 0.4.1 external bench failed this five-for-five; the rebuild passes it on the first live attempt. The residual over-claim mechanism disclosed in 0f §9 was also observed live in the mild direction (an aside containing "dogfood" lit up `dogfood-finding-*` as matched on that single shared token) — the disclosure matches reality.

### 8. Correction supersedes — PARTIAL

- **Explicit path (the mechanism): PASS.** Two `iranti_write` calls on the same key: second value won, and `iranti_history` shows the old value with `reason: "superseded"` — never-hard-delete holding:

```json
{ "current": { "value": "…13 scorecard checks plus a DX/friction section…" },
  "history": [ { "value": "The dogfood eval report covers the 13 scorecard checks.",
                 "reason": "superseded" } ] }
```

- **Conversational path (the product bar): PARTIAL.** Stated *"we're using dogfood/report as the eval branch name"* (stored as `decision:dogfood-report-as-the-eval-branch-name`), later corrected *"Actually, the eval branch name should be dogfood/report-1, not dogfood/report."* The correction was extracted (`correction:the-eval-branch-name` = "the eval branch name is dogfood/report-1") and **ranks above** the old fact on the follow-up question — but the stale decision fact stays live and also returns `matched: true` directly beneath it. A host reads two contradictory matched facts with no supersession marker; worse, the project-state rollup's `recentDecisions` surfaces only the stale one (see check 10). The corrected value wins by rank, not by supersession.

### 9. Project isolation, adversarially — PASS

What I did (the live store cannot safely take a second process — Layer 0's disclosed no-cross-process-lock): copied `~/.iranti/db` to scratch, then ran the **real MCP tool layer** (`attend`/`query`/`search`/`history`/`archive`/`projectStatus` from `src/mcp/tools/*`) via tsx from a temp folder that resolves to a different project (`"source": "fallback"`), against the copy containing every fact from this session. Probed with the same question, the same `entityHints`, and three raw fact UUIDs captured live. Verbatim results:

```json
"attend":        { "rules": [], "facts": [], … }
"query_entity_key": { "found": false, "fact": null }
"search_dogfood":   { "count": 0, "results": [] }
"history_by_id":    { "found": false, "current": null, "history": [] }
"archive_by_id":    { "archived": false, "reason": "No active fact with that id in your project scope (unknown id, already archived, or outside this project)." }
```

Zero leakage on all six surfaces, and the out-of-scope message is byte-identical to the one a nonsense UUID gets (verified against `00000000-…`). The Feature-3 UUID leak class is closed in live usage, not just in tests.

### 10. Checkpoint + resurrection — PASS (one rollup caveat)

Checkpoint with `stage: in_progress`, `status: "checks 1-8 and 11 done; bench runs and isolation test remaining"` was accepted and round-trips exactly (`iranti_query` on key `checkpoint` returns the full text; the write response echoed stage/status). `iranti_project_state` returns:

```json
{ "latestCheckpoint": { "text": "Dogfood eval of iranti-next in progress. Done: cold contact, …",
    "stage": "in_progress",
    "status": "checks 1-8 and 11 done; bench runs and isolation test remaining" },
  "recentDecisions": [ { "key": "decision:dogfood-report-as-the-eval-branch-name",
                         "value": "dogfood/report as the eval branch name" } ],
  "openItems": [], "gapMs": 6075, "isLongGap": false }
```

Would a returning developer be oriented? Yes — what's done, what's next, how long it's been. **Caveat:** `recentDecisions` names the *stale* branch (`dogfood/report`); the conversational correction (check 8) lives under `correction:*` and never reaches the rollup, so the reorientation brief contains one confidently wrong detail. The 300-char clamp (disclosed, 0e §9-adjacent review hardening) truncates mid-word but keeps the payload bounded.

### 11. History & archive honesty — PASS

Archived the junk negation fact (a genuinely wanted cleanup): `{"archived": true, "factId": "f5edfdb3-…"}`. It stopped surfacing (`iranti_query` → `found: false`), and history preserved its past: `{"current": null, "history": [{"value": "is on record for the HTTP transport", "reason": "archived_by_user"}]}`. Archiving the all-zero UUID: `{"archived": false, "reason": "No active fact with that id in your project scope…"}` — an honest refusal, not a fake success.

### 12. The instrument itself — PASS

`pnpm bench` twice: green both times (38.6s / 39.6s), `bench/latest.json` **raw byte-identical across the two invocations** (node compare, no stripping needed), all seven overall metrics at 0.0pp vs baseline and matching the morning report's table exactly: recall 74.5 / precision 100.0 / hit-rate 85.7 / confirmation 64.3 / false-positive 75.0 matched + 100 raw / rule-relevance 81.3 / rule-noise 0.0. No drift.

### 13. Developer-experience verdict — see next section. Net: the protocol is right; the visibility gaps are the friction.

---

## DX & friction notes (feeding the parked redesign discussion)

**Payload economy — the single biggest improvement over old iranti.** A typical iranti-next attend response in this session was 15–40 lines of directly injectable content. The old server's attend on the *same session's* turns returned multi-hundred-line payloads: `debug`, `refinementPass`, `attendantToolPlan`, `councilConsultationPlan`, `subTurnLoopPlan`, duplicate `injectionBlock` re-serializations of facts already listed, drift lectures, and compliance counters. One old-iranti mid-turn attend here cost more tokens than every iranti-next call in this eval combined. Whatever the redesign keeps, keep this.

**Latency:** every iranti-next call felt instantaneous (deterministic, no LLM). Old iranti's attends visibly think. The 1.2s/turn ai-mem complaint is structurally gone.

**`extracted[]` under-reports and it cost me trust.** It only carries deterministic artifacts (URLs/paths); semantic extraction runs in the post-response fire-and-forget chain, so a message full of decisions returns `extracted: []` and the facts only become visible on the *next* attend. Twice I concluded "it stored nothing" prematurely. Either report heuristic extractions (they're synchronous-capable — `HeuristicExtractor.extract` is sync work in a resolved promise) or add a response field saying "semantic extraction pending."

**Correctability asymmetry:** facts are listable, archivable, historied; **rules and aliases have no list/deactivate MCP surface at all** (library functions exist, unexposed). Rules being additive makes this compound: there is no host-reachable way to see what rules exist, let alone retire one.

**Post-response extraction from host summaries is the junk vector.** The check-3 fabrication came from *my own* protocol-compliant post-response message, not from NF-style user text. Host summaries are dense in category nouns ("decision", "constraint", "we must"). Consider: never run bare-noun patterns (`decision[:\s]+`, `constraint[:\s]+`) on host-authored/post-response text, or gate autowrites behind the reduced-confidence source they already carry *plus* exclusion from `matched` eligibility.

**Protocol ergonomics:** `nextDue` is a genuinely good teaching device. Old iranti's hook-enforced protocol (handshake + per-lookup attends + per-edit writes + compliance ledger) dominated this session's token spend on the non-test server; iranti-next's three-phase loop was easy to hold in working memory and never nagged. For the subagent-memory/mid-turn-cost thread: mid-turn attends here were cheap (3-fact budget, no rule rescan) — the economics parked in the redesign discussion look solved-by-default in this design.

**Shape nits:** (a) `iranti_search`/`iranti_query` lack the `matched` flag (disclosed 0f §9 follow-up — agreed, do it; search results carry no relevance signal at all today). (b) The checkpoint's `accessCount: 0` even after `project_state` returned it — access tracking seems to skip the rollup path. (c) `entityHints` requiring `{entityType, entityId}` on every call invites drift in entityId spelling across sessions; a "default to current project" shorthand would remove the most repetitive argument.

---

## Ranked top-5 fix list (severity × first-user annoyance)

1. **Negation-blind bare-noun extraction patterns fabricate facts** (check 3). `\bdecision[:\s]+` turned "no rate limiting decision is on record" into a stored decision. It's the anti-thesis bug: silent, plausible, wrong, and self-inflicted via the protocol's own post-response summaries. *Fix:* drop bare `decision:`/`constraint:` noun patterns on non-user text (or entirely — the corpus shows verb-phrase patterns do the real work), and/or add a negation guard (`no|never|without|isn't|not\b.{0,20}` preceding the noun → skip).
2. **Bare repo-relative paths are invisible to `extractArtifacts`** (check 4 caveat), which also silently disables alias learning — the textbook feature — for the most common way developers reference files. *Fix:* extend `RELATIVE_PATH_PATTERN` to prefix-less multi-segment paths (require ≥2 segments + a file extension to stay precision-safe).
3. **No MCP surface to list or deactivate rules** (check 6). Additive rules + no recourse = a wrong rule fires on every relevant turn forever. First bad rule a real user writes, they hit this. *Fix:* expose `iranti_rules_list` + `iranti_rule_deactivate` (library functions already exist).
4. **Conversational corrections don't supersede** (checks 8/10). `correction:*` coexists with the stale `decision:*`, both `matched: true`, and the project-state rollup surfaces only the stale one — the reorientation answer contains a known-corrected error. *Fix:* when a `correction:` fact's subject-slug token-overlaps an existing fact key on the same entity, archive that fact as superseded (deterministic, same tokenizer); at minimum exclude keys shadowed by a newer correction from `recentDecisions`.
5. **Clause-termination drops long natural sentences** (checks 2/3): capture patterns end only at `[.,;]` within 60–80 chars, so em-dash-punctuated sentences (NF's actual writing style) extract nothing — both of my session-opener facts died to this. *Fix:* add `—`/`–`/` - ` to the terminator class; cheap, measurable on the harness before/after.

*(Honorable mention, DX not correctness: make `extracted[]` reflect semantic extraction so hosts can see what was learned in-turn.)*

---

## Scorecard summary

| # | Check | Verdict |
|---|---|---|
| 1 | Cold first contact | PASS |
| 2 | Write → confirm | PARTIAL (extraction miss upstream; confirm path itself clean) |
| 3 | Extraction honesty | FAIL (one invented negation fact; keys/dedupe otherwise clean) |
| 4 | Textbook alias | PASS (URL path; bare relative paths can't carry an alias) |
| 5 | Alias paraphrase ceiling | EXPECTED-LIMIT (disclosed; disclosure accurate) |
| 6 | Rules surface/noise/deactivate | PASS surface + noise 2/2; deactivate leg unrunnable (no tool) |
| 7 | No-answer honesty | PASS |
| 8 | Correction supersedes | PARTIAL (explicit path PASS; conversational leaves stale fact live) |
| 9 | Project isolation (adversarial) | PASS (6/6 surfaces, id probes included) |
| 10 | Checkpoint + resurrection | PASS (rollup surfaces one stale decision) |
| 11 | History & archive honesty | PASS |
| 12 | Bench determinism | PASS (byte-identical, matches report) |
| 13 | DX verdict | Protocol economics excellent; visibility/correctability gaps are the friction |

**Cutover judgment:** the retrieval, isolation, honesty-labeling, checkpointing, and measurement layers behaved as promised under adversarial live use — those are the hard parts, and they held. The extraction heuristics are the soft part, and fix-list items 1 and 3 (fabrication vector; uncorrectable rules) are the two I would not ship a first external user without.

*Dogfooded: this eval's findings were written into iranti-next itself as `dogfood-finding-*` facts, a checkpoint, and one archived junk fact — the store's own history is part of the evidence.*
