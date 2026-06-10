# System Alignment & the Enforcement Question

**Status:** review / decision-in-progress
**Date:** 2026-06-10 · **Author:** Claude (with NF)
**Feeds:** Phase 3 PRD (the Attendant) · **Related:** [iranti-core PRD](../rough-notes/iranti-core-prd.md) §2, §6, §8, §13; [protocol-enforcement spec](../specs/observability/protocol-enforcement.md); [bidirectional-attendant spec](../specs/intelligence/bidirectional-attendant.md)

---

## 1. Why this doc exists

After Phase 2.5 shipped, we stepped back to ask whether the system as **built and running** still aligns with the goals in the iranti-core PRD. It mostly does in the library and intelligence layers — and it has drifted hard in one place: the **agent-interaction layer**, where the lived behaviour is the *opposite* of the founding principle. That drift is not an accident; it is an enforcement regime compensating for a feature that isn't built yet. This doc records the finding, the decision about what enforcement should be, and the attend-lifecycle model that follows from it. It is input to the Phase 3 PRD, not a phase PRD itself.

## 2. The alignment finding: a founding-principle inversion

The PRD's thesis, stated verbatim in three places:

> §2 — *"The agent passes raw information through and iranti decides what to store… The agent is **not responsible** for making memory decisions."*
> §8 — *"The agent is **passive** on the write side. It does not call write tools manually."*
> §2 — *"Iranti is **invisible** to the user… they should never have to think about iranti directly."*

What actually runs today (observed across this session): the agent is forced by hooks and a write-guard to call `iranti_attend` before every reply and `iranti_write` after every edit, is **blocked** from proceeding until it hand-authors facts, and decides entity/key/value/why for every write itself. The agent is maximally *active* on the write side; Iranti is the most *visible* thing in the loop.

This is not a small drift. It is the inverse of the thesis. The cause: MCP hosts call tools, they don't stream the full conversation to Iranti, so **autonomous write-routing (the real intelligence) has no stream to route from.** Until that exists, the only way memory accumulates is the agent feeding it by hand — and enforcement is the only way to make a forgetful agent do that reliably. **The enforcement layer is a scaffold standing in for an unbuilt feature.** The risk is mistaking the scaffold for the product.

## 3. Done-enough scorecard (PRD §13)

| Criterion | Status | Note |
|---|---|---|
| Attendant bidirectional, **agent passive on writes** | 🔴 | Retrieval works; writes are agent-driven + enforced. The core inversion. |
| Fact storage / retrieval / conflict / resolution | 🟡 | Storage, conflict-detect, escalation ✅. Resolution loop needs the Archivist (unbuilt). |
| Archivist: decay + Hebbian | 🔴 | Phase 4, unbuilt. Edges accumulate weight but never decay; no decay daemon. |
| Rules fire by **context match** not similarity | 🟡 | Rules inject, but *all* in-scope-entity rules fire — not true context-triggering. |
| Session grouping | 🟢 | Done. |
| Knowledge graph + traversal retrieval | 🟡 | Graph exists; two-pass graph-hop is Phase 3. depth>1 CTE has a known bug (backlog gate). |
| MCP: Claude Code + 1 other host | 🟡 | Claude Code ✅; HTTP (CORE-12) opens the door; no 2nd host validated. |
| CLI minimal surface | 🔴 | Phase 6, unbuilt. |
| Hybrid triggers + correction:injection measurable | 🟡 | Reactive ✅; periodic drift *heartbeat* not built; `attend_log` makes the ratio measurable. |

Roughly **40% of "done enough,"** with the highest-weighted criterion the one most absent.

### On-vision (credit where due)
- **"Not itself an LLM / deterministic harnesses"** (§2) — strongly held: conflict resolution, reliability scoring, D7 formula, edges are all deterministic.
- **Transparent & auditable** (§2, §10) — provenance, append-only archive, ledger.
- **Source reliability + conflict detection** (Phase 2b) — real and tested.
- **Graph foundation** (Phase 2a) — interface-abstracted exactly as §7 demands.

The drift is confined to the agent-interaction layer. The substrate is sound.

## 4. The enforcement decision: Branch C (harness-guaranteed invocation)

We considered three framings:

- **Branch A — enforcement is a scaffold to remove.** Preserves *invisible* and *negligible overhead*; requires building autonomous stream write-routing first (the §13 "what is the stream" open question).
- **Branch B — enforcement is a product pillar.** Iranti enforces memory hygiene *on* agents. Defensible and currently working, but **breaks** *invisible* and *negligible overhead*, and promotes protocol-enforcement from a minor Phase 7 host-conformance toggle into a core agent-conformance thesis the PRD has no room for.
- **Branch C — enforcement guarantees the calls happen, but the harness makes them, not the agent.** ← **chosen.**

**Decision (2026-06-10): Branch C.** Enforcement should *guarantee* the lifecycle calls fire at the right moments **without the agent orchestrating them**. Move invocation from agent-driven (nag + block) to harness-driven (hooks fire the calls).

### Why this is not a betrayal of the founding principle
The pre-response *retrieval* is **already** harness-driven — the `UserPromptSubmit` hook calls attend and injects the result without the agent asking. The current friction is that the harness does this **and then also requires the agent to re-orchestrate the whole lifecycle manually.** Branch C just finishes the job:

| Lifecycle beat | Today | Branch C |
|---|---|---|
| Pre-response retrieve | Hook injects **+** agent must also call attend | Hook only; agent does nothing |
| Write after an edit | Write-guard **blocks** agent until it hand-writes facts | `PostToolUse:Edit` captures the diff, routes it to the Librarian autonomously |
| Mid-turn discovery | Agent must remember to re-attend | `PostToolUse:Read/Grep` fires a mid-turn attend for the new entity |
| Post-response persist | Agent must remember, or compliance nags next turn | `Stop` hook fires post-response, routes + closes the turn |

The middle row **is** the PRD's "autonomous write routing" (§6, §8) — delivered through Claude Code's hook surface instead of stream-parsing. Because the agent spends ~zero tokens orchestrating, Branch C **restores** *invisible* and *negligible overhead* — the two principles Branch B breaks. The write-guard can then be deleted, not tuned.

### The load-bearing cost (must be accepted consciously)
Hooks are a Claude-Code capability. Codex, bare MCP hosts, chat hosts, and the SDK path do **not** have `Stop`/`PostToolUse` equivalents. **Harness-driven invocation is therefore not model/agent-agnostic** (a direct tension with §2). The resolution is not to treat hooks as the mechanism with degraded fallbacks — it is to identify the **universal mechanism** and treat hooks as sugar on top.

### The universal mechanism: the attend payload IS the stream *(amended 2026-06-10, same day)*

Ask what Iranti controls on *every* host — including a pure chat host with no files and no hooks:

1. **The attend payload.** Every host that calls `iranti_attend` passes `latestMessage` / `currentContext`. That is the conversation stream arriving server-side, turn by turn. The PRD's open question "what counts as the stream?" has a de facto answer already running: **the stream = the accumulated payloads of attend calls.** Identical for coding sessions and plain conversations.
2. **The server side of every tool call.** Extraction, write-routing, compliance tracking all live behind the tool boundary where the host cannot opt out. Phase 2b's extractor-inside-attend and v0's `toolResult` / response-capture autowrites are the embryo.
3. **The tool response channel.** Every result flows back into the model's context on every host — a universal carrier for protocol breadcrumbs ("here is what is due next"). The agent follows the note on the last result; it never tracks the lifecycle itself.

**The agent's only universal obligation collapses to one habit: call attend every turn and hand over the conversation. Everything else happens server-side from that payload.** One habit is enforceable with one server-side check; six rules requiring the agent to hand-author facts is what produced the write-guard pain.

**Write-guard fate, revised:** not deleted — *inverted*. Its diagnosis ("observations happened that are not in memory") is correct; its remedy (block until the agent does the Librarian's job) is the inversion this review documents. Cross-host remedy: when the guard fires, **Iranti performs the writes itself** from material it already holds, tagged `attendant_autowrite` at reduced confidence, and **warns** instead of blocking. Blocking survives only as the configurable `enforce` level of the protocol spec, not the default. The guard degrades from roadblock to backstop extractor.

The ladder, restated honestly:

1. **Universal floor (every host, chat or code):** attend-payload-as-stream + server-side extraction + breadcrumb responses. This is the real autonomous write routing — and the *conversational* case proves it, because there it is the only possible mechanism (no edits to capture).
2. **Rich-hook hosts (Claude Code):** hooks automate the one remaining habit — they fire the attend calls themselves. Agent fully passive. Sugar, not foundation.
3. **The irreducible gap:** a bare host whose agent never calls attend gets no memory. No server-side architecture closes that; it is an integration-quality problem surfaced by warn-level ledger lessons.

Consequence: the quality load shifts entirely onto **server-side extraction** (today a 9-pattern heuristic + optional local LLM). That — not hooks — is the Phase 3 centerpiece.

## 5. The attend lifecycle: pre / mid / post

The three phases are not three flavours of one call. They are the moments the two sides of the bidirectional Attendant fire (§8: "both sides run every turn"). **Pre and mid are the retrieval heartbeat; post is the write heartbeat.**

| Phase | Job | Side | Trigger (Branch C) | Economics | Guarantee |
|---|---|---|---|---|---|
| **Pre-response** | Retrieve before the agent thinks: relevant facts, fired rules, active checkpoint, drift corrections vs window | Read | turn start — `UserPromptSubmit` | full fact budget, full rule scan | **Hard** (hook can't be skipped) |
| **Mid-response** | Top up memory when the work reveals new scope (file opened, new entity hit) | Read, incremental | discovery — `PostToolUse:Read/Grep`, new entity in stream | small budget (~3), dedup vs this turn, skip rule rescan | Best-effort (depends on agent's actions) |
| **Post-response** | Persist the turn: route signal to Librarian, write findings, update checkpoint, ledger event, advance counters | Write + bookkeeping | turn end — `Stop` | consolidation + checkpoint | **Hard** (Stop hook) |

## 6. Open questions (carry into Phase 3 PRD)

1. **Is mid-response a first-class phase, or just "pre, repeatable"?** Leaning first-class: distinct trigger (discovery vs turn-start) *and* distinct economics (small budget, dedup, no rule rescan). But it's the phase most tempting to collapse into pre.
2. **Where does write-routing truly happen — continuously (per-edit `PostToolUse`) or batched (post-response)?** Leaning *both*: per-edit capture is cheap and is what lets us delete the write-guard; post-response consolidates and checkpoints. Needs a concrete split of responsibilities.
3. **Per phase, hard guarantee vs best-effort?** Post-response persist should be guaranteed (Stop hook); pre-response retrieve is guaranteed (UserPromptSubmit); mid-turn is inherently best-effort. The enforcement *level* (off/warn/enforce from the protocol spec) should probably vary by phase and by host tier, not be a single global switch.
4. **The write-guard's fate.** ~~Delete it~~ **Invert it** (amended same day): the guard's detection stays, its remedy changes — on firing, Iranti auto-writes from held material (`attendant_autowrite`, reduced confidence) and warns; blocking becomes the opt-in `enforce` level only. Open sub-question: what payload retention does the backstop extractor need server-side to do this well?
5. **What counts as "the stream"** (§13 open item) for tier-2 streaming hosts. Still unanswered; Branch C lets us defer it for Claude Code but not forever.

## 7. Implications for Phase 3

Phase 3 is "the Attendant" — and this review changes its shape:

- Phase 3's centerpiece is **server-side extraction from attend payloads** — the universal autonomous write routing that works on chat hosts and coding hosts alike. The hook-invocation model (which hook drives which phase on Claude Code) is a deliverable, but it is tier-2 sugar, not the foundation.
- Phase 3 should **invert the write-guard** (auto-write + warn replaces block-and-demand) and add `PostToolUse`-driven edit capture as the Claude-Code enhancement on top.
- The **protocol-enforcement spec** (currently Phase 7, host-conformance, warn/enforce) needs to graduate early and be re-scoped to cover **agent-lifecycle conformance across the host capability ladder**.
- **PRD §2 wording** ("invisible", "negligible overhead", "model/agent agnostic") should be reconciled with the capability-ladder reality: behaviour is agnostic, invocation mechanism is tiered.

## 8. Decision log

- **2026-06-10 — Enforcement framing = Branch C** (harness-guaranteed invocation; agent passive; write-guard slated for deletion; capability ladder for non-hook hosts). Supersedes the implicit Branch-B-mechanics-under-Branch-A-philosophy state that this review surfaced.
- **Open** — phase semantics (§6 Q1–Q5) to be resolved in the Phase 3 PRD.
