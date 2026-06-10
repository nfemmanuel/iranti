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
Hooks are a Claude-Code capability. Codex, bare MCP hosts, and the SDK path do **not** have `Stop`/`PostToolUse` equivalents. **Harness-driven invocation is therefore not model/agent-agnostic** (a direct tension with §2). The resolution is a **capability ladder**, not a single mechanism:

1. **Rich-hook hosts (Claude Code):** full harness-driven invocation. Agent passive.
2. **Streaming hosts:** Iranti observes the stream and routes autonomously (the original PRD vision; still needs the stream defined).
3. **Bare hosts:** fall back to agent-driven tool calls + lightweight enforcement (warn, not block).

Iranti's contract stays the same across the ladder; only the *mechanism of invocation* degrades. This keeps the agnostic principle honest: the **behaviour** is host-independent even though the **enforcement mechanism** is not.

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
4. **The write-guard's fate.** Under Branch C the guard becomes redundant (PostToolUse routes writes). Confirm we delete it rather than keep it as a belt-and-suspenders fallback — it is the single largest source of the friction this review documents.
5. **What counts as "the stream"** (§13 open item) for tier-2 streaming hosts. Still unanswered; Branch C lets us defer it for Claude Code but not forever.

## 7. Implications for Phase 3

Phase 3 is "the Attendant" — and this review changes its shape:

- Phase 3 must **specify the harness-invocation model** (which hook drives which phase) as a first-class deliverable, not an afterthought.
- Phase 3 should **build `PostToolUse`-driven write-routing** and **delete the write-guard** — this is the concrete first instance of autonomous write routing.
- The **protocol-enforcement spec** (currently Phase 7, host-conformance, warn/enforce) needs to graduate early and be re-scoped to cover **agent-lifecycle conformance across the host capability ladder**.
- **PRD §2 wording** ("invisible", "negligible overhead", "model/agent agnostic") should be reconciled with the capability-ladder reality: behaviour is agnostic, invocation mechanism is tiered.

## 8. Decision log

- **2026-06-10 — Enforcement framing = Branch C** (harness-guaranteed invocation; agent passive; write-guard slated for deletion; capability ladder for non-hook hosts). Supersedes the implicit Branch-B-mechanics-under-Branch-A-philosophy state that this review surfaced.
- **Open** — phase semantics (§6 Q1–Q5) to be resolved in the Phase 3 PRD.
