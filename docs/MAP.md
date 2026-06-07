# iranti-core docs

iranti is automatic context engineering for AI agents.

This folder is the map for everything needed to plan, design, and build iranti-core. It is organized by layer: rough thinking at the top, product decisions in the middle, technical design below that, and engineering standards underneath everything. Documents earn their folder when they are ready to be written properly. Everything starts in rough-notes.

**Status key:** `draft` · `template` · `deferred` · `complete`

---

## Research

Market and competitive intelligence.

| Document | Status | Description |
|---|---|---|
| [Competitive landscape](research/competitive-landscape.md) | `research` | Who is building in the AI memory space, what they have built, and where iranti is differentiated. Sourced and adversarially verified. |

---

## Rough notes

Where thinking starts. Documents here are unpolished and subject to change without notice.

- [Early thoughts](rough-notes/early-thoughts.md) — Mental models, library metaphor, initial Staff descriptions, and rambling notes from the start of the rebuild.
- [iranti-core PRD](rough-notes/iranti-core-prd.md) `draft` — The master product requirements document for iranti-core. **Start here.**

---

## Package PRDs

One PRD per top-level package. iranti-core is the active one. The rest are future scope and hold only what is known so far.

| Document | Status | Description |
|---|---|---|
| [iranti-core](prds/iranti-core.md) | `draft` | Automatic context engineering for AI coding agents. |
| [iranti-web](prds/iranti-web.md) | `template` | Memory for general chatbot interfaces. Out of scope for now. |
| [iranti-control-plane](prds/iranti-control-plane.md) | `template` | Operational control layer. Design when the time comes. |
| [iranti-benchmarking](prds/iranti-benchmarking.md) | `template` | Evaluation and benchmarking suite. |

---

## Feature specs

31 features from section 9 of the iranti-core PRD, organized by the group they belong to. Each earns a full spec when it is ready to be built. The phase listed is when it is built in the [build sequence](rough-notes/iranti-core-prd.md#12-build-sequence).

### Memory and storage

| Spec | Phase | Status |
|---|---|---|
| [Fact storage](specs/memory-storage/fact-storage.md) | 1 | `template` |
| [Session grouping](specs/memory-storage/session-grouping.md) | 0 | `template` |
| [Knowledge graph](specs/memory-storage/knowledge-graph.md) | 2 | `template` |
| [Checkpoints](specs/memory-storage/checkpoints.md) | 3 | `template` |
| [Rules and preferences](specs/memory-storage/rules-and-preferences.md) | 3 | `template` |
| [Media storage](specs/memory-storage/media-storage.md) | deferred | `deferred` |

### Retrieval

| Spec | Phase | Status |
|---|---|---|
| [Two-pass retrieval](specs/retrieval/two-pass-retrieval.md) | 3 | `template` |
| [Context window observation](specs/retrieval/context-window-observation.md) | 3 | `template` |
| [Reactive retrieval](specs/retrieval/reactive-retrieval.md) | 3 | `template` |
| [Periodic drift check](specs/retrieval/periodic-drift-check.md) | 3 | `template` |
| [Graph traversal retrieval](specs/retrieval/graph-traversal-retrieval.md) | 2–3 | `template` |

### Memory lifecycle

| Spec | Phase | Status |
|---|---|---|
| [Memory decay](specs/lifecycle/memory-decay.md) | 4 | `template` |
| [Hebbian reinforcement](specs/lifecycle/hebbian-reinforcement.md) | 2 | `template` |
| [Archive](specs/lifecycle/archive.md) | 1 | `template` |
| [Conflict detection and resolution](specs/lifecycle/conflict-detection.md) | 2 | `template` |
| [Human conflict resolution](specs/lifecycle/human-conflict-resolution.md) | 4 | `template` |

### Intelligence

| Spec | Phase | Status |
|---|---|---|
| [Source reliability scoring](specs/intelligence/source-reliability.md) | 2 | `template` |
| [Autonomous write routing](specs/intelligence/autonomous-write-routing.md) | 3 | `template` |
| [Bidirectional Attendant](specs/intelligence/bidirectional-attendant.md) | 3 | `template` |

### Integration

| Spec | Phase | Status |
|---|---|---|
| [MCP host support](specs/integration/mcp-host-support.md) | 5 | `template` |
| [CLI](specs/integration/cli.md) | 6 | `template` |
| [SDK](specs/integration/sdk.md) | 6 | `template` |
| [Python client](specs/integration/python-client.md) | 6 | `template` |
| [Dev mode](specs/integration/dev-mode.md) | deferred | `deferred` |
| [Graph backend abstraction](specs/integration/graph-backend-abstraction.md) | 0 | `template` |

### Observability and accounts

| Spec | Phase | Status |
|---|---|---|
| [Usage analytics](specs/observability/usage-analytics.md) | 7 | `template` |
| [Cloud account and backup](specs/observability/cloud-account-backup.md) | deferred | `deferred` |
| [Session ledger](specs/observability/session-ledger.md) | 7 | `template` |
| [Agent registry](specs/observability/agent-registry.md) | 7 | `template` |
| [Protocol enforcement](specs/observability/protocol-enforcement.md) | 7 | `template` |
| [System self-awareness](specs/observability/system-self-awareness.md) | 7 | `template` |

---

## Technical design

Design documents for systems that span multiple features. These are written before the relevant phase begins, not after.

| Document | Status | Needed by |
|---|---|---|
| [Schema](technical/schema.md) | `template` | Phase 0 |
| [Graph backend interface](technical/graph-backend-interface.md) | `template` | Phase 0 |
| [MCP tool surface](technical/mcp-tool-surface.md) | `template` | Phase 5 |
| [Security architecture](technical/security-architecture.md) | `template` | Phase 5 |
| [Access control](technical/access-control.md) | `template` | Phase 5 |

---

## Engineering standards

How we write, test, and ship code. Applies across the whole project. These should be written before the first line of code.

| Document | Status |
|---|---|
| [Coding standards](engineering/coding-standards.md) | `template` |
| [Git workflow](engineering/git-workflow.md) | `template` |
| [CI/CD setup](engineering/ci-cd.md) | `template` |
| [Testing strategy](engineering/testing-strategy.md) | `template` |

---

## Deferred specs

Explicitly parked. Each is noted in section 13 of the iranti-core PRD. No build starts without a full spec.

| Document | Status | Blocked on |
|---|---|---|
| [Cloud account](deferred/cloud-account.md) | `deferred` | Full privacy and encryption spec |
| [Media storage](deferred/media-storage.md) | `deferred` | Own spec before build |
| [Cold start learning](deferred/cold-start-learning.md) | `deferred` | No decisions made yet |
| [Team collaboration](deferred/team-collaboration.md) | `deferred` | Access grant and delegation model |
| [Cloud encryption architecture](deferred/cloud-encryption.md) | `deferred` | Cloud account spec |
| [GDPR compliance](deferred/gdpr-compliance.md) | `deferred` | Cloud account spec |

---

## Build sequence at a glance

| Phase | What gets built | Done when |
|---|---|---|
| **0: Foundation** | Schema, GraphBackend interface, Docker Compose, TypeScript types, seed script | Schema is designed, types are defined, Docker runs |
| **1: The Library** | Prisma schema, core CRUD, archive, entity registry | Write a fact, read it back, archive it, query by entity and session |
| **2: The Librarian** | Write path, conflict detection, source reliability, PostgreSQL graph | Write two facts, see conflict resolution or escalation, query relationships |
| **3: The Attendant** | Retrieval, handshake, two-pass retrieval, stream observation, write routing, drift check | Bidirectional retrieval and routing without the agent driving either side |
| **4: The Archivist** | Scheduled scan, memory decay, escalation processing, `iranti resolve` | Full maintenance cycle runs, decay is active, resolved escalations apply |
| **5: MCP integration** | MCP tool surface, Claude Code integration, second host, end-to-end tests | Real agent session produces stored facts, retrieves them in later session |
| **6: CLI and SDK** | CLI operations, TypeScript SDK, Python client | Install iranti, bind to a project, query memory, build a simple SDK agent |
| **7: Observability** | Session ledger, metrics, telemetry, agent registry, protocol enforcement | Full session events recorded, metrics queryable, telemetry pipeline active |
| **AGE (parallel)** | Apache AGE graph implementation | Runs alongside phase 2 onward; switchover is a config change when ready |
