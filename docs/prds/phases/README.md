# Phase PRDs

**[Back to map](../../MAP.md)** · **[Backlog](../../backlog.md)** · **[Implementation reference](../../engineering/implementation.md)**

---

Every phase and every standalone feature in iranti-core starts as a PRD in this folder **before** any code is written, and the PRD is updated when the work lands. This is a hard process rule, instituted June 2026 after an audit found product behaviour drifting from the master PRD because decisions were being made in code and chat rather than on the record.

The three planning documents work together:

| Document | Role | Tense |
|---|---|---|
| **Master PRD** ([rough-notes/iranti-core-prd.md](../../rough-notes/iranti-core-prd.md)) | The vision. What iranti is and why. Rarely changes. | Timeless |
| **Phase PRDs** (this folder) | The contract for one phase. What we will build, the decisions, the acceptance bar. Written before build. | Future → past |
| **Backlog** ([backlog.md](../../backlog.md)) | The ordered queue. What is next, what is in flight, what is done. | Present |
| **Implementation reference** ([implementation.md](../../engineering/implementation.md)) | The living retrospective. What was actually built and why, decision by decision. Updated after build. | Past |

A phase PRD is **proposed**, discussed and signed off, then **accepted**, then implemented, then marked **shipped** with a closing changelog entry. No phase moves to code while its PRD is still `proposed`.

---

## Template

Copy this structure for every new phase PRD. Keep it tight — a phase PRD is a contract, not an essay.

```markdown
# PRD: Phase X — <Name>

**Status:** proposed | accepted | shipped
**Phase:** X · **Date:** YYYY-MM-DD · **Author:** <name>
**Related:** master PRD §<n>, spec(s), backlog item ID(s)

---

## 1. Summary
One paragraph. What this phase delivers and why it matters now.

## 2. Problem & motivation
Which of the master PRD's problems this addresses. What is broken or missing without it.

## 3. Goals & non-goals
- **Goals:** the outcomes this phase must achieve.
- **Non-goals:** what is explicitly out of scope, so scope creep is visible.

## 4. Scope
- **In:** concrete deliverables.
- **Out (deferred):** named, with the phase that picks each up.

## 5. Design decisions & rationale
Each material decision as: decision → why → alternative rejected. This is the section that prevents re-litigation.

## 6. Schema / API changes
Tables, columns, tool signatures, response shapes. "None" is a valid answer.

## 7. Acceptance criteria
Checkbox list. Each item is observable and testable.

## 8. Deltas from the master PRD
Where this phase diverges from the master PRD's section 12 sequence or section 8 behaviour, and the justification. "None" is a valid answer.

## 9. Risks & open questions
What could invalidate this, what is still undecided.

## 10. Verification
How we know it works: test counts, smoke checks, manual validation.

## Changelog
- YYYY-MM-DD — proposed
- YYYY-MM-DD — accepted
- YYYY-MM-DD — shipped (commit, test results)
```

---

## Index

| PRD | Phase | Status |
|---|---|---|
| [Phase 0 — Library Foundation](phase-0-foundation.md) | 0 | shipped (retroactive) |
| [Phase 1 — MCP Server](phase-1-mcp-server.md) | 1 | shipped (retroactive) |
| [Phase 1.1 — Tool Realignment](phase-1.1-tool-realignment.md) | 1.1 | shipped (retroactive) |
| [Phase 1.2 — Context Window Observation](phase-1.2-context-window-observation.md) | 1.2 | shipped |
| [Phase 2a — Graph Foundation & Write Safety](phase-2a-graph-and-write-safety.md) | 2a | shipped |
| [Phase 2b — The Librarian](phase-2b-librarian.md) | 2b | shipped |
| [Phase 2.5 — HTTP, Telemetry & Hardening](phase-2.5-http-telemetry.md) | 2.5 | shipped |
| [Phase 3 — The Attendant: Retrieval](phase-3-attendant-retrieval.md) | 3 | shipped |
| [AX-1 — Key Normalization](ax-1-key-normalization.md) | AX-1 (hardening) | shipped |
| [AX-2 — Content-Hash Extraction Cache](ax-2-content-hash-cache.md) | AX-2 (hardening) | shipped |
| [OD-4 — Media Ingest](od4-media-ingest.md) | OD-4 (Media track) | shipped |
| [Layer 0 — Zero-Infra Foundation & Folder-Scoped Projects](layer-0-foundation.md) | Layer 0 (YC foundation) | accepted |
| [Layer 0b — Minimal Measurement Harness](layer-0b-harness.md) | Layer 0b (YC foundation) | shipped |
| [Layer 0c — Entity Resolution](layer-0c-entity-resolution.md) | Layer 0c (YC foundation) | accepted |

> Retroactive PRDs (0, 1, 1.1) document phases that shipped before this process existed. They are written from the implementation record and exist so the history is complete and auditable — the standard going forward is PRD-first.
