# iranti — Positioning (v0 draft)

**Status:** draft for NF review · **Date:** 2026-06-28 · **Author:** Claude (with NF)
**Grounded in:** Byterover competitive intel + verified user-voice scrape (this session). See memory keys `byterover_competitive_intel_2026_06_28`, `byterover_user_voice_findings_2026_06_28`, `positioning_lean_anchor_and_expand`, `positioning_enforcement_pillar`.

> This is a positioning artifact, not a spec. It exists to commit to an identity before the rebuild sets scope (PRD-first rule). Two decisions are deliberately left open at the end for NF to ratify.

---

## 1. The situation (one paragraph)

The "memory for AI agents" thesis is validated — a funded competitor, **Byterover** (open-source CLI `brv`, formerly Cipher), sells it across 22–24 coding agents via MCP. But Byterover made a revealing bet: it abandoned vector/graph/embedding infrastructure for LLM-curated markdown ("zero infrastructure"), and in doing so shipped a memory layer whose **single worst, churn-causing flaw is that it fabricates memories** (`brv curate` invents entries not in the source) and processes user context through an **undocumented second LLM**. Those two complaints are the only ones that showed up across independent users. The category's deepest unmet need is not *more places to remember* — it's **memory you can trust to be accurate, private, and durable.**

## 2. Identity (recommended)

**iranti is the enforcement layer for agent memory: governed, provable, local.**

Byterover gives an agent memory — a passive library of tools the agent *may* call. iranti gives you **governed** memory — policies enforced at the read/write boundary on every agent, with an audit trail you can show. That is the one structural thing Byterover cannot bolt on without becoming a different product.

> Byterover: *"portable memory for coding agents."*
> iranti: *"memory your agents can't corrupt, and you can prove."*

## 3. The wedge — promise + mechanism

| Layer | Role | What it is | Why Byterover can't easily follow |
|---|---|---|---|
| **Trust** | The promise | Never fabricates; every fact carries provenance; nothing persists unsourced | Their architecture actively fabricates today |
| **Enforcement** | The mechanism + moat + money | Declarable memory policies enforced at the boundary (provenance required, PII stays local, retention rules) — provable via audit | They have no governance layer; it's a different product |
| **Invisible** | The constraint | Enforcement acts on *data/outcomes*, never as agent bookkeeping ceremony | They use manual git-like curation rituals |
| **Local** | The trust substrate | Local-first by default, BYO-LLM, no surprise cloud LLM hop | Directly answers their corroborated privacy complaint |
| **Cross-tool** | The reach | One policy set holds across every agent/editor | "Portable" for them still means coding-only |

**Coding agents (Cursor / Claude Code) are the discovery doorway, not the identity.** We show up in the category people already search; we win on governance they can't match.

## 4. What the pillars mean as testable behavior

These are the claims the rebuild must be able to *demonstrate*, not assert:

- **Never fabricates:** no fact is persisted that isn't traceable to a source input. (Byterover's #1 churn cause.)
- **Provenance by default:** every stored fact carries who/when/source; a "write receipt" is producible on demand. (A user literally requested this.)
- **Local by default:** no user context leaves the machine unless an explicit, named policy allows it. (Answers the hidden-second-LLM complaint.)
- **Enforced, not requested:** the above hold regardless of whether the agent "cooperates" — they're guarantees at the data boundary, not chores the agent must perform.
- **No silent loss:** a write either durably succeeds with a visible result or fails loudly. (Byterover's silent-0-operations bug.)

## 5. The trap we must not fall into

Enforcement has two faces. iranti **currently ships the wrong one.**

- ❌ **Enforcing the agent's bookkeeping** — the agent *must* call attend/write every turn, gets scolded for forgetting. This is ceremony. It is annoying, it doesn't sell, and it block-listed the author of this very document mid-write today.
- ✅ **Enforcing policy on the data/outcome** — no unsourced fact persists; PII never leaves local; provenance auto-attaches. Invisible to the agent. This is the moat.

**The rebuild's central job is to flip enforcement from face ❌ to face ✅: enforce the outcome, not the agent's effort.** If we market "enforcement" but deliver "call six tools per turn," we've shipped today's bug as a headline feature.

## 6. What stays at parity (don't gold-plate)

The coding-agent MCP integration must be *present and credible* — same plumbing as Byterover so a user can A/B us in the same category. We do **not** try to out-engineer Byterover on raw coding-memory features. Parity there; differentiation budget goes to Trust + Enforcement.

## 7. Honest risks

- **Small sample.** User-voice signal is ~20–25 self-selected issue-filers. Directional, not statistical. It's enough to *order* the bets, not to size the market.
- **Stuck-in-the-middle.** Splitting focus across coding + general could leave us worse than Byterover at coding and not compelling at general. Defense: parity on the anchor, differentiate on governance.
- **Enforcement-as-ceremony.** See §5 — the failure mode is shipping the current product with better marketing.
- **Audience pull.** "Governance" tilts toward an enterprise/compliance buyer, away from Byterover's solo-dev hobbyist. Probably good (defensible, monetizable) but a deliberate choice (PD-2 below).

## 8. Open positioning decisions (for NF)

**PD-1 — Is enforcement the *spine* or the *moat under a trust headline*?**
- (a) **Spine / identity** — "governed memory" is the category. *(Recommended: it's a more ownable, defensible category than "trustworthy memory," which any competitor can claim.)*
- (b) **Moat under trust** — lead with "trust," keep enforcement as the supporting mechanism.

**PD-2 — Which buyer do we optimize for first?**
- (a) **Enterprise / governance-first** — compliance, audit, policy; higher willingness to pay; smaller top-of-funnel.
- (b) **Individual dev-first, enterprise as upside** — match Byterover's entry, grow into governance. *(Leaning: dev-first entry with the architecture built so enterprise governance slots on top — mirrors the OD-3 "additive, no-migration" pattern.)*

## 9. Tagline candidates (placeholders)

- "Memory your agents can't corrupt — and you can prove."
- "Governed memory for AI agents."
- "The memory that follows you everywhere, and never makes things up."

---

*Next artifact after PD-1/PD-2 are ratified: fold this into the rebuild scope / a proper PRD.*
