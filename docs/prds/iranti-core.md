# iranti-core

**Status:** draft (working document in rough-notes)  
**[Back to map](../MAP.md)**

---

The working draft of the iranti-core PRD lives in rough-notes while it is actively being written and revised. Once it stabilises, this file becomes the clean, promoted version.

**[Open the working draft →](../rough-notes/iranti-core-prd.md)**

---

## Quick reference

| | |
|---|---|
| **What** | Automatic context engineering for AI coding agents. |
| **Tagline** | iranti makes agents remember without anyone asking. |
| **Scope** | Memory infrastructure: MCP integration, CLI, SDK, knowledge graph, all Staff agents. |
| **Out of scope** | iranti-web, control plane, benchmarking. |
| **Build phases** | 0–7. See §12 of the PRD. |
| **Done-enough criteria** | See §13 of the PRD. |

## The four problems iranti solves

1. **Silent drift** — Agents lose the thread of long sessions without warning.
2. **Compression amnesia** — Context window compression drops facts the agent cannot know are gone.
3. **The stale-context moment** — The agent treats established decisions as new information.
4. **Handoff loss** — Switching hosts forces the user to reconstruct context from memory.

## The Staff

| Role | Responsibility |
|---|---|
| **Attendant** | Per-agent, bidirectional. Retrieves context and routes writes simultaneously. |
| **Librarian** | Owns the write path. Chunks, resolves conflicts, and maintains source reliability. |
| **Archivist** | Scheduled maintenance daemon. Decays, archives, and processes resolved escalations. |

## Feature groups

- [Memory and storage](../MAP.md#memory-and-storage) — Facts, sessions, graph, checkpoints, rules
- [Retrieval](../MAP.md#retrieval) — Two-pass, drift check, graph traversal
- [Memory lifecycle](../MAP.md#memory-lifecycle) — Decay, Hebbian reinforcement, archive, conflicts
- [Intelligence](../MAP.md#intelligence) — Source reliability, write routing, bidirectional Attendant
- [Integration](../MAP.md#integration) — MCP, CLI, SDK, Python client
- [Observability](../MAP.md#observability-and-accounts) — Session ledger, analytics, agent registry
