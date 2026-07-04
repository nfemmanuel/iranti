# Dogfood evaluation prompt — iranti-next

Copy everything below the line into a FRESH Claude Code session opened in this repo
(`C:\Users\NF\Documents\Projects\iranti`). Authored 2026-07-04 by the overnight-build
orchestrator session; kept in the repo so the eval is reproducible.

---

You are dogfooding and evaluating **iranti-next** — the rebuilt iranti memory layer, running from this repo's own source. Two memory servers are connected in this session:

- **`iranti`** (old, production, v0): powers the session hooks. Comply with its protocol as usual, but it is **NOT under test**. Do not confuse the two.
- **`iranti-next`** (under test): the rebuild this repo IS. Its tools appear as `mcp__iranti-next__*`. It runs on an embedded database with a fresh, empty store — you are its first real user.

Your job is to be two things at once: a **genuine user** (talk to it the way a developer actually would — no keyword-engineered phrasing) and a **rigorous evaluator** (score every promise below against the incidents that motivated it, then write the report). Failures are findings, not embarrassments — this project deliberately shipped a rules-relevance score of 81.3% instead of a fake 100% and a false-positive rate of 75% instead of a predicted 0%, because honest instruments are the product thesis. Match that standard.

## Step 0 — Ground yourself (read before touching the tools)

1. `docs/reviews/2026-07-03-overnight-build.md` — what was built, the gauntlet results, the current benchmark numbers.
2. `docs/prds/phases/README.md` and from its index the Layer PRDs: `layer-0-foundation.md`, `layer-0b-harness.md`, `layer-0c-entity-resolution.md`, `layer-0d-rules-enforcement.md`, `layer-0e-checkpoints.md`, `layer-0f-no-answer.md` — each one records the motivating example, the design decisions, and the honest limitations. The §9 sections are the expected-weakness map: distinguish "known limitation, disclosed" from "new bug" when you score.
3. `docs/rough-notes/iranti-core-prd.md` — the vision (skim §s on principles).

## The motivations you are testing against (not abstractions — these incidents)

- **"Confirm, don't discover."** NF watched an agent in another chat re-derive the state of a repo from scratch — old iranti had the facts but the agent still had to go digging. The product bar: an agent should attend, EXPECT the memory to already know, and merely confirm it.
- **"The textbook."** NF repeatedly referred to a repo by its nickname and no memory system ever learned the mapping. Entity resolution exists so a nickname taught ONCE resolves forever.
- **Ignored standing preferences — NF's #1 pain.** Rules like "never use SELECT * in reporting queries" got stored and never surfaced at the moment they mattered. Rules enforcement exists to inject the right rule at the right moment and stay silent otherwise (noise is as much a failure as silence).
- **Project bleed.** All memories in one undifferentiated pot; facts from one project surfacing in another. Folder-scoped projects exist so isolation is the default and crossing is explicit + reversible.
- **The ai-mem benchmark of old iranti 0.4.1** (an external, adversarial test): 5/5 confident wrong answers on trick questions whose answers didn't exist → the `matched` flag (Layer 0f); a paraphrase gap structural to lexical matching → disclosed ceilings at 75%/81.3%; retrieval that cost 1.2s + an LLM call per turn while adding zero recall → the rebuild's attend is deterministic-first.
- **The market's junk-memory problem** (why determinism at all): Mem0's audited store was ~97.8% junk; ByteRover hallucinated its own repo's state; other tools failed writes silently. Hence G1 (deterministic/correctable — extraction precision is 100% by design, it never invents), G2 (host-portable), G3 (local-first/private), never-hard-delete, and precision-over-recall everywhere.
- **"Where did we leave off?"** Coming back after a gap should get a real answer (latest checkpoint + stage + recent decisions + open items), not a shrug.

## The scorecard — run all 13, in roughly this order, during REAL work

Do some genuine work in this session between checks (explore the repo, discuss the code — real usage is the test substrate). For each check record: what you said (verbatim), what iranti-next returned (relevant excerpt), PASS / PARTIAL / FAIL, and one sentence of judgment.

1. **Cold first contact.** Your very first `iranti-next` attend on this project, empty store: does it behave gracefully (clean empty-ish response, no errors), and does the response shape make sense to you as a host?
2. **Write → confirm.** Tell it a few real facts about this repo conversationally (a decision, a preference, a constraint — phrase them naturally). On a LATER turn, ask about one. Bar: the fact comes back, `matched: true`, at or near rank 1 — you CONFIRMED rather than re-discovered.
3. **Extraction honesty.** Check what it auto-extracted from your messages so far (search/query). Bar: nothing invented, keys sensible (normalized, categorized), no junk accumulation. This is the anti-Mem0 check.
4. **The textbook, literally.** Mention a real artifact (URL or doc) and in the same breath give it a nickname the way people actually do ("...everyone just calls it X"). Later — several turns later — ask for it BY NICKNAME ONLY. Bar: resolves, rank-1, as an `alias:*` entry, `matched: true`.
5. **Alias paraphrase ceiling (expected-fail probe).** Ask for that same artifact by a paraphrase that never uses the nickname. Bar per PRD 0c §9: expected MISS on the alias key — verify the miss happens AND note whether the underlying fact still surfaced some other way. A pass here would be surprising news; report it either way.
6. **Rules: surface when it matters.** Write a real standing rule via the rule tool (pick one you actually hold, e.g. about commits or tests). Then, turns later, describe a situation where it applies — naturally, without echoing the rule's wording. Bar: the rule appears in `rules[]`. Then have two unrelated exchanges. Bar: the rule does NOT appear (noise check). Then deactivate it and re-trigger: silent.
7. **No-answer honesty (the anti-trick-question check).** Ask about something plausible-sounding this project never decided ("what did we settle on for rate limiting?" style — invent your own). Bar: ZERO facts with `matched: true`; ambient context may flow but nothing claims to answer. This is the exact failure that embarrassed 0.4.1 five-for-five.
8. **Correction supersedes.** State a fact with a specific value; a few turns later correct it ("actually it's Y, not X"). Then ask. Bar: the corrected value wins; ideally the old value is visible in history, not vanished (never-hard-delete).
9. **Project isolation, adversarially.** From a DIFFERENT folder (e.g. spawn a shell in another project dir, or note this needs a second session in a sibling folder — do what's practical and say what you did), attempt to read the facts written here, including by any fact id you saw. Bar: nothing leaks; unknown-vs-out-of-scope indistinguishable.
10. **Checkpoint + resurrection.** Write a checkpoint with a stage and status describing this eval session's progress. Bar: accepted with stage/status round-tripping (query it back). Then ask "where did we leave off?" via the project-state tool. Bar: the rollup names your checkpoint, its stage, and recent decisions. (True restart persistence is covered by the test suite; here judge the ANSWER's usefulness — would a returning developer actually be oriented by it?)
11. **History & archive honesty.** Archive one fact you wrote. Bar: honest result reporting; the fact stops surfacing; history still shows its past. Try archiving a nonsense id. Bar: honest `archived: false` — not a fake success.
12. **The instrument itself.** Run `pnpm bench` twice (each ~40s). Bar: green both times, byte-identical metrics, numbers matching the morning report's table (recall 74.5 / precision 100 / hit 85.7 / confirmation 64.3 / fp 75.0 matched + 100 raw / rules 81.3 / noise 0.0). Any drift = finding.
13. **Developer-experience verdict.** Throughout, note friction: latency you felt, response payload size, anything confusing in tool shapes, anything the OLD iranti's protocol does that the new one handles better or worse. The parked redesign discussion (subagent memory, mid-turn attend cost, token economy) feeds on exactly these observations — capture them.

## Method rules

- **Realistic phrasing only.** The corpus authors got burned once for writing probes that secretly echoed the answers (the 100%→81.3% story in PRD 0d §9). Do not repeat that mistake in the other direction either — don't contrive weird phrasing just to force failures.
- **Verbatim evidence.** Quote the actual tool responses in the report; paraphrased evidence is not evidence.
- **Known-limitation vs bug.** Before scoring a FAIL, check the relevant PRD's §9 — if it's disclosed, score it "EXPECTED-LIMIT (disclosed)" instead, and judge whether the disclosure matches what you observed.
- **Dogfood the writes.** Your own durable findings from this eval should be written INTO iranti-next as you go — using the system to record its own evaluation is part of the test.

## Deliverable

Write `docs/reviews/2026-07-04-dogfood-iranti-next.md`: the 13 verdicts with evidence, a DX/friction section, and a ranked **top-5 fix list** (severity × how much it would annoy a first-time user). Commit it on branch `dogfood/report-1` and push. Then give NF a chat summary: one line per check, leading with anything that would block flipping `iranti-next` to be THE iranti.
