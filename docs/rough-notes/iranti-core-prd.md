# iranti-core PRD (draft v1)

## 0. Preamble
There is currently a working version of iranti that people can download and use. It works reasonably well in practice. However, there are aspects of iranti that feel lacking in ways that have made me decide to take a step back, take stock of where things are, and rebuild with more intention. The following are the reasons for starting over.

- **The codebase is a bit of a mess.** I built iranti in a very iterative way, and while that got something up and running quickly, it has left the codebase harder to maintain and build on than I would like.
- **Most of the code is vibecoded.** The original plan was to use this project to learn how to write code properly and think in terms of good practices and system design. I did a lot of the work while exhausted and as a result I do not fully understand how the internals work. I want to understand every part of what I have built, which will make it easier to talk about and easier to grow.
- **Some features do not work the way I intended.** Features that are currently implemented do not behave exactly as expected, and those gaps are becoming problems because I am expecting different results. This is my chance to look closely at the system and make sure everything works according to my vision.
- **I plan on applying for funding soon.** I intend to apply to YCombinator and other funding routes, and I need to fully understand and document the product. Any potential new hires should also be able to navigate the codebase without needing me to explain it to them.
- **New ideas require reworking existing systems.** Iranti has grown considerably since I first conceived it, and some of the current systems need to change to accommodate where it is going. A clean rebuild is the right moment to do that.

Throughout this document, Agents refers to LLMs and coding agents that interact with iranti directly. Users refers to the human individuals who use Agents and, through them, iranti.


## 1. Problem and motivation

The core problem iranti solves is this: AI agents have no persistent memory, and the degradation of their context is invisible to everyone involved.

This shows up in four concrete ways.

**Silent drift.** Over the course of a long session, an agent gradually loses the thread of what you were doing. There is no warning. You only discover the gap when a response feels wrong or disconnected, by which point the drift has already affected the work.

**Compression amnesia.** When a context window fills and compresses, large chunks of prior conversation vanish at once. The agent continues confidently as if nothing happened. It does not flag what was dropped, because it does not know what was dropped. Neither do you.

**The stale-context moment.** You reference something established earlier in the conversation, a decision, a constraint, a file, and the agent treats it as brand new information. Everything that came before that moment effectively did not count.

**Handoff loss.** When you switch hosts because you prefer a different model for a specific task, or because your current session has degraded and you need a fresh start, you become the transfer mechanism. You reconstruct context from your own memory. The things you forget to carry over are almost always the things you stopped consciously thinking about: approaches that did not work, the reasoning behind a past decision, constraints established weeks ago. You only remember them when the new agent runs into the same wall you already hit.

All four problems share a single root: there is no reliable external store of what has happened. Context is ephemeral, and its degradation is invisible until it causes damage, whether it happens gradually within a session or suddenly across hosts.

## 2. Philosophy and principles

Iranti is an autonomous memory layer for AI agents. Through iranti, agents share a persistent brain that grows with use, carries context across sessions and hosts, and surfaces the right information without being explicitly asked.

Iranti is guided by the following principles.

- Iranti values near perfect recall first above all else, then prioritizes low cost, and then speed.
- Iranti stores anything with future learning value, including working ideas, failed approaches, decisions, constraints, context, and metadata. It discards information with no signal, like idle chatter and pleasantries that no future agent or user would benefit from knowing.
- Iranti is behavior-agnostic and invocation-tiered. The memory model — what is stored, how conflicts resolve, how facts decay, what is retrieved — is identical across every host (Claude, Codex, Copilot) and every model it runs on (Anthropic, OpenAI, etc.) *given the same input*. What varies by host is how iranti is invoked and how much signal it can capture: rich-hook hosts can drive the attend cycle automatically with the agent fully passive, while bare hosts depend on the agent to call attend and on how much context the host passes through. The guarantee is uniform behavior for identical input — not uniform input. Because input richness varies by host, autonomous capture quality varies with it, and the universal floor (server-side extraction from the attend payload) must be strong enough to carry the thin-payload hosts.
- Iranti is lightweight. The total cost in terms of tokens and resources of using iranti for tasks that require any amount of continuity should be negligible.
- Iranti is not itself an LLM. It is memory infrastructure for other LLMs and coding Agents.
- Iranti's primary modus operandi is not LLM thinking. Similar to Claude Code CLI, most of iranti is going to be processes and harnesses and tools and other things that the AI model can use, but it should not be the main part of the system.
- Iranti is the active intelligence behind its own memory. The agent passes raw information through and iranti decides what to store, how to decompose it, and how to index it. The agent is not responsible for making memory decisions.
- Iranti is invisible to the user. The user interacts with the agent and the agent uses iranti. When everything works correctly, the user simply notices that their agent remembers things. They should never have to think about iranti directly.
- Iranti is transparent and auditable. Because iranti makes autonomous decisions about what to remember and what to surface, it must be possible to inspect what has been stored, understand why it was stored, and correct it when it is wrong. A memory system that operates with no recourse is a liability, not an asset.

## 3. Goals and non-goals

### Goals

- Iranti eliminates hallucination caused by missing or degraded context.
- Iranti helps agents learn from what has worked and what has not, reducing rediscovery and preventing repeated mistakes.
- Iranti maintains complete awareness of its own state at all times, including its version, metrics, connected sessions, and provenance.
- Adding iranti to any agent interaction should add negligible overhead in tokens, latency, and cost.
- Iranti reduces the total token cost of achieving a task over time by eliminating redundant re-discovery, preventing expensive dead ends, and injecting only the context that is needed.

### Non-goals

- Iranti is not a general knowledge base. It knows only what it has observed in the sessions and projects it was active in, and it has no connection to external information or the internet.
- Iranti does not make technical or strategic decisions for agents. It surfaces what the user has established and what the system has learned, but the agent's judgment on technical matters remains its own.
- Iranti does not replace documentation tools. It stores what happens in sessions, not human-authored documentation, and is meant to complement tools like wikis and project docs rather than replace them.
- Iranti does not store idle chatter or content with no signal for future work.
- Iranti does not function without an agent host in normal operation. It is infrastructure, not a standalone product.


## 4. Users and use cases

Iranti-core has three primary user groups. All three are in scope from the initial build.

### Developers and vibe coders

These are people building projects with AI coding agents over days, weeks, or months. They use tools like Claude Code, Codex, and Copilot heavily and have come to know the degradation curve intimately: the agent is sharp at the start of a session, but the further in you go, the more the context window fills and the worse things get. Facts get forgotten. Decisions that were made get re-litigated. The agent starts making suggestions that contradict things established earlier. People who hit this regularly develop workarounds. They open a new conversation, write summary prompts, or paste in context by hand. All of that is friction they should not have to manage.

Iranti's promise to this user is that the degradation curve flattens. The agent stays sharp through the whole session because iranti offloads memory as it accumulates, keeps the context window lean, and surfaces only what is needed at each moment. You do not restart. You do not paste in summaries. You keep working.

### Agent builders

These are developers building AI-powered tools, products, and workflows for other people. They are not just using iranti. They are embedding it in what they build so that their users get persistent memory as part of the product. Their relationship with iranti is closer to an integrator than an end user. They care about clean APIs, reliable behaviour, and documentation that lets them build on top of iranti without needing to understand every internal detail.

For this group, iranti is infrastructure they deploy, not a tool they use directly. The quality of iranti's integration surface is as important as what iranti does.

### (Iranti-web users — out of scope for this document)

General chatbot users who use Claude.ai, ChatGPT, and similar interfaces have the same underlying context problems but cannot install or configure iranti directly. They are the primary audience for iranti-web, which is a separate product built on top of iranti-core. They are not in scope for this document.

## 5. Hosts and integration model

A host is any system that connects to iranti on behalf of an agent. Every host, regardless of type, must satisfy a minimum contract: it registers itself with iranti when it connects, provides a session identifier, and is responsible for making iranti's outputs available to the agent it represents. In return, every host receives the same core set of responses: relevant context from memory, corrections when the agent's current context contains inaccurate or stale information, and rule injections when a stored user preference is triggered by the current situation.

What varies across host types is the depth of the integration and the surface area the host is expected to provide.

### MCP hosts

MCP, or Model Context Protocol, is an open standard that lets AI agents connect to external tools and services. MCP-based agents such as Claude Code and Codex represent the most capable integration path. An MCP host connects to iranti at session start, registers itself with a session identifier and structured metadata, and streams the conversation to iranti as it progresses. Iranti observes that stream, manages memory writes autonomously, and surfaces injections when a retrieval is warranted.

The host is responsible for receiving iranti's outputs and making them available in the agent's context at the right moment. It does not decide what to inject or when. That is iranti's job. The host simply delivers the result.

### CLI

The CLI (command-line interface) is for mid-to-high level developers who want direct control over iranti without going through an agent session. It is primarily an operational tool: querying memory, inspecting what has been stored, managing facts, and verifying that iranti is working as expected. The CLI is not a streaming integration in the same way as MCP hosts. It is intentional and interactive rather than continuous and passive.

### SDK and programmatic API

Agent builders who embed iranti in their own products use the SDK (software development kit) or programmatic API. This is the integration surface designed for people building on top of iranti rather than using it directly. The SDK exposes the same core capabilities as the MCP integration but in a form that can be wrapped, configured, and deployed as part of a larger product. For this integration path, the quality of the API surface and documentation matters as much as what iranti does. The builder's users will never see iranti, but the builder needs to understand it completely.

### Dev mode

Dev mode allows direct interaction with iranti without going through an agent host. It is intended for testing, debugging, and inspecting iranti's internal state. It is not a production path and agents in live sessions do not use it.

### Web hosts (out of scope for this document)

Web-based hosts such as Claude.ai and ChatGPT are out of scope for iranti-core. They are the integration target for iranti-web, a separate product built on top of iranti-core. The distinction is noted here so the boundary is clear: iranti-core makes no assumptions about browser environments or web-based delivery.

## 6. Agent roles

Iranti's internal components are collectively called The Staff. Each plays a distinct role in keeping memory healthy and keeping agents well-informed. The knowledge store itself is the Library. It is not an agent. It is the data store every staff member reads from and writes to.

### The Librarian

The Librarian owns the write path. Every piece of information that enters the knowledge store passes through the Librarian first. It receives signal routed by the Attendant, chunks raw content into atomic facts, detects conflicts with existing stored information, resolves conflicts automatically when it can, and escalates to a human reviewer when it cannot. It also maintains source reliability scores: over time, sources that win conflicts consistently are trusted more and their writes carry more weight automatically without any configuration.

The Librarian never receives raw conversation stream directly. Filtering and routing is the Attendant's job. The Librarian only receives what the Attendant has already decided is worth storing.

### The Attendant

The Attendant is per-agent and bidirectional. One instance exists per external agent per session. It is the intelligence layer between the conversation and the knowledge store, working in both directions at once.

On the retrieval side, the Attendant reads the conversation stream, infers what the agent is working on, and surfaces relevant context from the knowledge store. It filters for what is actually needed rather than dumping the full knowledge base into the agent's context. It also checks what is already in the agent's context window before injecting anything, so it never re-inserts information that is already present and never adds noise.

On the write side, the Attendant watches the same stream and decides what has signal worth storing. It routes that signal to the Librarian for processing. The agent does not call write tools manually. The Attendant handles write routing autonomously.

This bidirectional design is one of the core departures from the original iranti, where the Attendant was retrieval-only and the agent was responsible for driving writes.

### The Archivist

The Archivist is a scheduled maintenance daemon. It does not run on every write and does not participate in the real-time flow of a session. It runs periodically to keep the knowledge store healthy.

On each cycle it archives entries whose validity has expired, archives entries whose confidence has fallen below the minimum threshold, applies memory decay to reduce the confidence of facts that have not been accessed recently, and processes any conflict escalation files that have been resolved by a human reviewer. The Archivist never deletes anything. The worst outcome of a bad archiving decision is a messy archive, not lost knowledge.

When the Librarian cannot resolve a conflict automatically, it escalates it to a folder of markdown files. Human reviewers work through those using the `iranti resolve` command, which writes the resolution in the format the Archivist expects. The Archivist picks it up on its next cycle and applies it to the knowledge store.

## 7. Memory primitives and data model

Iranti stores several distinct types of information and they are not all the same. Treating them the same is a design mistake. The sections below define each primitive, how it is identified, and how it lives in the system.

### The fact

The fact is iranti's primary unit of memory. Every piece of session knowledge, including decisions made, approaches that failed, constraints established, and preferences expressed, is stored as a fact. A fact is identified by three things: an entity type, an entity id, and a key. The entity type describes the category of thing being described, such as a project, an agent, a file, or a session. The entity id is the specific instance. The key describes what about that entity is being recorded. Together these three form the unique address of any fact in the system.

A fact carries a confidence score from 0 to 100. This score is iranti's responsibility, not the host's or the agent's. The Attendant assigns initial confidence when routing signal from the stream, and the Librarian applies source reliability weighting on top of that. Scoring happens inside iranti to ensure consistent behaviour across all hosts. A fact also carries its source, timestamps for when it became valid and when it expires if it does, a last-accessed timestamp used for decay, and a stability score that controls how quickly it decays.

### Rules and preferences

Rules and preferences are stored differently from facts. They do not decay. They are not retrieved by similarity search. When a situation in the conversation matches a stored rule, the rule fires and is injected into the agent's context. This is a fundamentally different retrieval pattern from facts, which surface because their content is relevant to a query. Rules are triggered by context. Storing them the same way as facts causes them to compete with facts on retrieval, which is what undermined their effectiveness in the original iranti.

### Checkpoints

A checkpoint is a compressed summary of a task or session state, written by the Attendant at meaningful moments during a session. Checkpoints serve two purposes. When a session is interrupted, a checkpoint allows another session or agent to resume from a known position without reconstructing context from individual facts. When context about a whole task is needed, retrieving a checkpoint is more efficient than assembling the same picture from dozens of individual fact lookups. Checkpoints work well in the current system and carry forward to the rebuild unchanged.

### Media (future scope)

Media such as images, documents, and audio will be stored in object storage rather than in the knowledge base directly. The knowledge base holds the metadata and a generated text description for each media item. On retrieval, the description and metadata surface first. The Attendant escalates to the actual media when the user signals dissatisfaction with what the description provided, or when it judges that the information gap cannot be closed without the real content. Audio media requires transcription at ingest time to be searchable. This is future scope and not in the initial build, but the schema should accommodate it from the start.

> **Note (2026-06-28):** Object storage for media **shipped** via OD-4 in this build cycle — local-FS backend behind an S3-ready abstraction, with vision-model semantic tagging (description + tags) at ingest. Entry point: `iranti_ingest_media` MCP tool; results surface in `AttendResult.media[]`. Code lives in `src/media/`, `src/library/media.ts`, and `src/mcp/tools/ingest-media.ts`. The original vision text above remains intact as the architectural intent. Audio transcription and the cloud (S3) backend remain future scope.

### Two categories of memory

Iranti stores two fundamentally different categories of memory and manages them differently.

Session memory is everything iranti has observed across the projects and sessions it has been active in. This grows over time as the system accumulates facts, decisions, failed approaches, preferences, and context. It is the primary knowledge store.

System memory is iranti's knowledge of itself, including its version, who built it, its operational metrics, the sessions it is connected to, and its internal state. This is not learned from observation. It is maintained by iranti about iranti and is not subject to the same lifecycle rules as session memory.

### The lifecycle of a fact

A fact begins active. While active it is subject to decay: confidence decreases over time based on how long since it was last accessed, calibrated by its stability score. A fact that is accessed frequently stays confident. A fact that sits untouched fades. When a newer, higher-confidence fact replaces an existing one, the older fact moves to the archive as superseded. When the Librarian detects a conflict it cannot resolve, the contested fact moves to the archive with a pending resolution state and an escalation file is created for human review. Facts with explicit expiry dates are archived when that date passes. Facts whose confidence has decayed below the minimum threshold are archived by the Archivist on its next maintenance cycle.

Protected facts sit outside this lifecycle entirely. They never decay and cannot be superseded. They are reserved for system-critical information that must always be available.

The archive is permanent. Nothing is ever deleted. The worst outcome of a bad archiving decision is a messy archive, not lost knowledge.

### Facts strengthen through use

The lifecycle model has two parallel tracks running simultaneously.

Individual fact strength follows the decay model above. Relational strength works differently. When the Attendant retrieves a set of facts together to answer a query, it records that co-access and the graph edges between those facts gain confidence. Paths that are frequently traversed together become stronger and surface earlier in future retrievals. This applies Hebb's principle from neuroscience: facts recalled together are strengthened together.

The inverse holds equally. If two facts exist but are never retrieved together, their connection stays weak or never forms. Relationships are earned through use, not just inferred at write time. Spurious connections that look plausible but never prove useful fade out naturally, keeping the graph clean.

### Facts as a graph

Every fact is a node in a traversable graph. Connections between facts form automatically based on temporal co-occurrence, entity overlap, and semantic similarity. Retrieval can walk the graph rather than only matching a query against isolated records. This makes questions like "what else was related to the decision we made last Tuesday" answerable without anyone defining those connections upfront.

The graph layer is abstracted behind an interface from the start. Two implementations sit behind that interface. The first uses recursive CTEs (a standard SQL technique for querying hierarchical and connected data) on the existing relationship table in PostgreSQL, the relational database iranti uses to store all of its data. The second uses Apache AGE, an extension for PostgreSQL that adds dedicated graph database capabilities and a graph query language called Cypher. The Librarian and Attendant call only the interface. When the AGE implementation is ready and the manual approach shows its limits, switching is a config change and a migration, not a rewrite.

## 8. Inner workings

This section describes how iranti processes a session in motion. It covers how the stream is observed, how writes happen, how retrieval is triggered, and what the Attendant does before injecting anything into the agent's context.

### Iranti observes the full conversation stream

The agent does not decide when to write or what to write. Iranti watches everything that passes through the session — user messages, agent responses, tool calls, file contents, and any other material the host surfaces — and makes memory decisions itself. This is why iranti is AI-powered: the line between signal worth storing and noise worth discarding cannot be drawn by a rule set. It requires judgment.

The stream is iranti's source of truth. Every other operation — writing, retrieving, correcting — originates from what the Attendant sees in the stream.

### The write path

Raw content from the stream reaches the Attendant. The Attendant filters it and routes what has signal worth storing to the Librarian. The Librarian receives that signal, chunks it into atomic facts, checks for conflicts with existing stored information, resolves what it can, escalates what it cannot, and writes the resulting facts to the knowledge store. It also updates the graph: new co-access patterns are recorded, edges are strengthened, and relationships are inferred from the shape of the information.

The agent is passive on the write side. It does not call write tools manually. This is the core departure from the original iranti, where the agent was responsible for deciding what to store and when.

### The retrieval path

When a query or task comes in, the Attendant searches iranti's memory for relevant context and surfaces it to the agent. The agent uses that context to generate its response. This resembles retrieval-augmented generation in structure, but with a critical difference: the corpus is live. Iranti's memory grows and updates in real time as the session progresses. This makes the write path as important as the retrieval path.

Retrieval is two-pass. After the primary search returns the most directly relevant facts, iranti runs a secondary pass for peripheral facts that scored lower but could still be useful. The distinction is between what the query clearly needs and what might matter at the edges. Both are surfaced, weighted differently, so the agent receives the full picture without noise dominating.

### Context window observation

Before injecting anything, the Attendant checks what is already in the agent's context window. If accurate information is already present, it stays silent. Re-injecting what is already there would be redundant and wastes tokens. If the context window contains stale or inaccurate information, iranti surfaces the correct version as a correction rather than an addition. The injection decision is always relative to the current window state, not absolute. The host must either give iranti read access to the current context or report its state as part of the retrieval request.

### Retrieval triggers

The Attendant runs two retrieval modes simultaneously.

Reactive retrieval fires when the Attendant detects a signal in the stream that memory is needed: a new entity is mentioned, the topic shifts, a complex question arrives, or the user references something from a prior session. This handles the obvious moments efficiently.

Periodic retrieval fires every N turns regardless of what the Attendant thinks is needed. It is a lightweight drift check, not a full retrieval — it compares what iranti knows against what is currently in the context window and surfaces corrections if anything has become stale. N is configurable. The right value depends on the workload and will become clear through observation as the system is used in practice.

Both modes run together. Reactive retrieval handles the clear moments. Periodic retrieval catches the slow drift that does not announce itself.

### Media re-injection

When media metadata and a generated description have been injected, the Attendant escalates to the actual media under two conditions. The first is user dissatisfaction: the user signals that the description did not give them what they needed. The second is a system-level gap judgment: the Attendant determines the information cannot be resolved without the real content. Both are honest escalation signals rather than arbitrary thresholds.

### The flow of a single turn

The user message arrives. The Attendant reads it as part of the stream. It checks whether this is a reactive retrieval moment. Separately, it checks whether the periodic counter has reached N turns. If either condition is met, it performs the appropriate retrieval and checks the context window state before injecting. It injects what is missing, corrects what is wrong, and stays silent if the window is clean.

Simultaneously on the write side, the Attendant identifies signal in the incoming and outgoing content worth storing and routes it to the Librarian. The Librarian processes the write, updates the knowledge store, records co-access patterns, and strengthens the relevant graph edges.

Both sides of the Attendant run every turn. The retrieval and write paths are not sequential — they happen in parallel within the same turn.

## 9. Features

Each entry is one line of description and one line of why. When a feature is ready for implementation, it earns its own spec document linked from here. Nothing longer than two lines belongs in this section.

### Memory and storage
- **Fact storage.** Stores any piece of knowledge as an atomic fact addressed by entity type, entity id, and key. Why: this is the foundation everything else builds on.
- **Session grouping.** Every fact is tagged with the session that produced it, enabling time-based retrieval. Why: "what did we work on last Tuesday" cannot be answered without it.
- **Knowledge graph.** Facts are nodes in a traversable graph with automatically inferred relationships. Why: related facts that share no explicit connection can still be found together through traversal.
- **Checkpoints.** Compressed task summaries written at meaningful session moments. Why: allows session recovery and faster bulk context retrieval than assembling from individual facts.
- **Rules and preferences.** User-defined rules stored separately from facts, triggered by context rather than retrieved by similarity. Why: agents should follow consistent user preferences without being re-told them.
- **Media storage.** Images, documents, and audio stored in object storage with metadata and generated description in the knowledge base. Why: agents work with more than text and iranti should extend to everything the user shares. *(Local-FS backend + semantic tagging shipped via OD-4, 2026-06-28. S3 backend and audio transcription remain future scope.)*

### Retrieval
- **Two-pass retrieval.** Primary pass for directly relevant facts, secondary pass for peripheral facts that might matter. Why: the answer to a question often depends on context the question did not explicitly ask for.
- **Context window observation.** The Attendant checks the current window before injecting to avoid redundancy and surface corrections. Why: re-injecting what is already present wastes tokens; letting stale information persist causes drift.
- **Reactive retrieval.** Retrieval fires automatically when the stream contains a signal that memory is needed. Why: agents should not have to ask for relevant context.
- **Periodic drift check.** A configurable heartbeat retrieval every N turns catches slow drift that reactive retrieval misses. Why: gradual context loss does not always announce itself.
- **Graph traversal retrieval.** Retrieval can walk the knowledge graph rather than only matching isolated records. Why: surfaces connections between facts that a similarity search alone would miss.

### Memory lifecycle
- **Memory decay.** Fact confidence decreases over time if the fact is not accessed, calibrated by a stability score. Why: stale facts should fade naturally rather than persisting indefinitely at full weight.
- **Hebbian reinforcement.** Graph edges between facts strengthen when those facts are retrieved together. Why: frequently co-accessed facts become easier to find together over time.
- **Archive.** Facts that expire, decay, or are superseded move to a permanent archive rather than being deleted. Why: nothing is lost, and bad archiving decisions can be reviewed and corrected.
- **Conflict detection and resolution.** The Librarian detects when a new fact contradicts an existing one and resolves it automatically when confidence gap is sufficient, escalating to human review when it is not. Why: the knowledge store must stay internally consistent.
- **Human conflict resolution.** The `iranti resolve` command guides a human reviewer through resolving an escalated conflict. Why: some conflicts genuinely require human judgment.

### Intelligence
- **Source reliability scoring.** Sources earn reliability scores over time based on how often their facts win conflicts. Why: not all sources are equally trustworthy, and weighting should reflect real-world track record rather than static configuration.
- **Autonomous write routing.** The Attendant decides what from the stream is worth storing and routes it to the Librarian without agent intervention. Why: consistent memory decisions across all hosts require iranti to own that judgment.
- **Bidirectional Attendant.** The Attendant handles both retrieval and write routing simultaneously within each turn. Why: the original design where agents drove writes produced inconsistent behaviour across hosts.

### Integration
- **MCP host support.** Iranti connects to MCP-compatible agents such as Claude Code and Codex. Why: MCP is the primary integration path for coding agents.
- **CLI.** Command-line interface for querying memory, managing facts, running diagnostics, and configuration. Why: developers need direct access to iranti without going through an agent.
- **SDK.** TypeScript SDK exposing the full iranti API for agent builders embedding iranti in their own products. Why: agent builders need a clean integration surface that does not require understanding iranti internals.
- **Python client.** Python HTTP client for the REST API. Why: many agent frameworks and research tools are Python-first.
- **Dev mode.** Direct iranti access without a host for testing and debugging. Why: building and validating iranti behaviour requires the ability to interact with it outside of a live agent session.
- **Graph backend abstraction.** The graph layer sits behind an interface with dual implementations for PostgreSQL and Apache AGE. Why: keeps the initial build simple while making migration to a dedicated graph backend a config change rather than a rewrite.

### Observability and accounts
- **Usage analytics.** Opt-out behavioural telemetry sent back to the developer. Why: understanding how iranti is actually used in practice is essential for improving it.
- **Cloud account and backup (future).** Optional user account enabling cloud backup of local memory and cross-device sync. Why: gives users portability and resilience, and creates a natural opt-in analytics surface. Requires full privacy and encryption spec before build.
- **Session ledger.** Structured audit trail of all staff events within a session. Why: operators need to inspect what iranti did and when, both for debugging and for accountability.
- **Agent registry.** Agents are registered entities with profiles, stats, and tracked activity. Why: knowing which agent wrote what fact is necessary for source reliability scoring and conflict attribution.
- **Protocol enforcement.** Configurable enforcement of the handshake and attend turn cycle. Why: hosts that skip the protocol produce degraded memory behaviour; enforcement catches this early.
- **System self-awareness.** Iranti maintains its own version, metrics, connected sessions, and operational state as a distinct memory category. Why: a system that cannot report on its own state is difficult to operate and debug.

## 10. Security and privacy

### What iranti must protect

Iranti stores memory — decisions, preferences, constraints, and context accumulated over time. This is among the most sensitive data a person produces in the course of working with AI agents. The security model must treat it accordingly.

### Access control

Memory is organised into entity namespaces. Access is granted at the namespace level, not at the individual fact level. An agent that has read access to `project/iranti/` can see any fact within that namespace, and the Attendant's relevance filtering determines which of those facts surface in any given turn.

Access is enforced at the API layer. An agent requesting facts from a namespace it does not have access to receives an error and no knowledge from that namespace is returned. This applies to revoked access as well: when a team member leaves a project, their agent's access to that project namespace is revoked and any subsequent request to that namespace fails with an access error.

There are three natural ownership categories.

Personal memory lives under the user's own entity namespace. Only that user and their agents can access it.

Project memory lives under a project entity namespace. The namespace owner can grant and revoke access for other users and their agents. Access grants are currently simple: an owner grants read or write access and can revoke it. The rules governing who else can grant access, delegation, and finer-grained permission tiers are deferred until real use cases make the requirements clear. The groundwork for an expandable access model is in place from the start.

System memory belongs to iranti and is not accessible to external agents or users.

### Encryption

For users who back up their memory to a cloud account, the encryption key is user-held. Iranti's servers store ciphertext and cannot read the content. This gives users full ownership of their data and makes a data breach on iranti's infrastructure meaningless from a content exposure standpoint.

The architectural consequence of this decision is that server-side intelligent retrieval is not possible on encrypted cloud memory — decryption must happen on the user's side before the Attendant can reason over the content. This shapes the cloud backup architecture significantly and the detailed design is deferred to the cloud account spec.

### PII and data minimisation

Iranti stores what it observes in sessions. Some of that will include personally identifiable information. The system does not need to detect or redact PII automatically in v1, but the schema must support explicit deletion at the fact level so that a user can request removal of specific stored information. This is required for GDPR compliance.

Usage analytics, when collected, must never include session content. Only behavioural metadata crosses the wire: feature usage, session counts, error rates, performance. No content, no fact values, no user messages.

### Audit trail

The session ledger records all staff events with timestamps and reasons. This provides an audit trail for what iranti stored, retrieved, and surfaced within any session. The ledger is separate from the knowledge store and is not subject to the same decay or archiving rules. It is a permanent record of system behaviour.

### Open items for future specs
- Detailed access grant and delegation model for team projects
- Cloud encryption architecture (client-side decryption flow, key management)
- Right-to-deletion implementation at the fact level
- Formal GDPR data processing agreement template for commercial deployment

## 11. Metrics and observability

Iranti has two distinct measurement audiences. One is operational: is the system healthy and behaving correctly? The other is product: is iranti actually working, and how are people using it? Both matter and they are tracked separately.

**Two data planes, never crossed.** This section governs *telemetry* — the data that flows back to the iranti developer (the organization) — which is anonymous behavioural metadata only. It does **not** govern the user's own instance. A user's iranti instance stores their facts, conversation-derived slots, and media in full — locally, and (Phase 5) in their own cloud backup. That private data plane is the product and is theirs. The analytics plane never reads it: product metrics are derived from behaviour (counts, frequency, latency), and even cloud-account-derived analytics for opted-in users carry behavioural metadata only — never fact values, message content, or anything that would reveal what a user is working on. So "never measure content" is a constraint on *what the developer collects*, not on what the user's instance stores.

### What iranti must never measure

No metric ever includes the content of a fact, conversation, or session. Usage analytics carries behavioural metadata only. This is a hard constraint, not a preference. It protects users, avoids GDPR exposure, and ensures that even if telemetry is intercepted, it reveals nothing meaningful about what users are working on.

### Operational metrics

These are for diagnosing whether iranti is running correctly. They are local and always available regardless of whether a user has opted into telemetry.

- API call volume and error rate by endpoint
- Attendant response time per turn
- Librarian write latency and conflict resolution rate
- Archivist cycle duration and count of facts archived, decayed, and escalated
- Session ledger gap detection (iranti was unreachable and a backfill may be needed)
- Knowledge store size over time (fact count, archive size)
- Source reliability score distribution (are some sources consistently winning conflicts?)

### Product and usage metrics

These are for understanding whether iranti is providing value. They are collected as opt-out behavioural telemetry where available, or through cloud account activity for opted-in users.

**The most important signal: disconnect rate.** Downloads tell you about interest. Whether someone is still connected after 30 days tells you whether iranti is actually providing value. A high disconnect rate is the clearest signal that something is not working. This is the number to watch most closely.

**Other product signals worth tracking:**

- Active installations and active instances per week
- Projects and repos connected per installation (are people using it on real work or just testing?)
- Sessions per project per week (frequency of use)
- Host distribution (Claude Code, Codex, SDK — shows where adoption is concentrated)
- Tokens used per session (proxy for session depth and cost)
- Attend call volume per session (how actively iranti is being queried)
- Fact count per project over time (is memory accumulating or stagnant?)

### Measuring whether recall is working

Direct measurement of successful recall requires reading session content, which is not allowed. The following proxies approximate it using behavioural signals only.

**Correction-to-injection ratio.** When the Attendant runs a drift check and finds stale information to correct, that is evidence the write path is working. A ratio skewed heavily toward corrections suggests the write path is falling behind. A ratio of almost entirely new injections with no corrections may mean drift checks are too infrequent or that iranti's memory is staying fresh.

**Short sessions on existing projects.** A new session on a project that ends in fewer than two turns often means the user opened a session, got their answer immediately from surfaced context, and closed it. That is a success, not a failure. Tracking this pattern as a proxy for effective recall is more honest than trying to verify whether a specific fact was correctly used.

**Disconnection events.** When a user unbinds iranti from a project, that is a strong signal that iranti was not helping on that project. Tracking which project types and host combinations produce disconnections points to gaps in recall quality or integration depth.

### What not to track

- Fact values or summaries
- Message content of any kind
- User identity beyond an anonymised installation identifier
- Session content even in aggregate form
- Anything that would allow iranti to read what a user is working on

## 12. Build sequence

> **Note (2026-06):** the sequence below is the original plan. As executed, MCP integration was pulled forward (to land a runnable loop early) and the foundation/library phases were folded together, so the as-built phase numbers differ from those here. The [backlog](../backlog.md#phase-numbering--reconciled) holds the authoritative phase mapping and is the live source for what is shipped and what is next. This section is preserved as the original intent. Three additional shipped tracks were inserted between the original phases and are not reflected in this sequence: AX-1 (key normalization, 2026-06-26), AX-2 (content-hash extraction cache, 2026-06-28), and OD-4 (media ingest, 2026-06-28) — each documented in the backlog and their respective phase PRDs.

The build is organised into phases. Each phase must be functionally complete before the next one depends on it. Where phases can run in parallel, that is noted. The goal is to have something runnable as early as possible so testing can happen against real behaviour rather than theory.

### Phase 0: Foundation

Everything else blocks on this. Get it right before writing anything else.

- Define the GraphBackend interface. This interface must be designed before either implementation is written, because the Librarian and Attendant will call it directly. Both the PostgreSQL manual implementation and the Apache AGE implementation must satisfy it.
- Design the full schema. PostgreSQL (the relational database iranti runs on) will hold tables for the knowledge base, archive, entity relationships, entities, entity aliases, and staff events. Every fact needs a session_id for temporal grouping, plus lastAccessedAt and stability fields for the decay model.
- Set up Docker Compose for local development. Docker is a containerisation tool that lets you run services like a database in an isolated, reproducible environment so that setup works the same way on any machine.
- Define shared TypeScript types for facts, relationships, staff events, and the GraphBackend interface.
- Write the seed script for the system namespace (operating rules, protected entries).

Nothing else starts until Phase 0 is complete and reviewable.

### Phase 1: The Library

The knowledge store with basic read and write operations. No intelligence yet, just a clean data layer.

- Drizzle schema and initial migrations matching the Phase 0 design. (Built on Drizzle, not Prisma — see implementation reference.) Drizzle is a TypeScript-first ORM that provides type-safe query helpers and manages schema changes through migrations.
- Core query functions: create, read, update, archive, find by entity, find by session.
- The archive table and archival functions (never delete, only archive).
- Entity registry and alias resolution.
- Basic relationship creation.
- Seed script running against the schema.

**Done when:** you can write a fact, read it back, archive it, and query by entity and by session in a running PostgreSQL instance.

### Phase 2: The Librarian and graph (PostgreSQL implementation)

The write path and the first graph implementation, built together because the Librarian creates edges when it writes facts.

- Librarian write path: receive signal, chunk into atomic facts, check for conflicts, resolve or escalate.
- Conflict detection and resolution with confidence gap logic.
- Source reliability scoring: track win/loss per source, apply weighted confidence on write.
- Escalation folder integration: write unresolvable conflicts to markdown files.
- PostgreSQL GraphBackend implementation: create vertices and edges using recursive CTEs on the relationship table.
- Automatic edge creation when facts are written: temporal co-occurrence, entity overlap.
- Hebbian reinforcement: update edge confidence on co-retrieval. The read path is partially needed here. Build just enough of Phase 3 retrieval to enable this, or stub it and complete it in Phase 3.

**Done when:** you can write two facts, see them stored correctly, write a conflicting fact and see it resolved or escalated, and query relationships between facts.

**Parallel track:** Start the Apache AGE graph implementation alongside this phase. Apache AGE is a PostgreSQL extension that adds native graph database capabilities, allowing iranti to run graph queries using a language called Cypher rather than recursive SQL. It does not need to be complete or active during Phase 2, but building it in parallel means the interface is validated and the switch-over is ready when needed.

### Phase 3: The Attendant

The intelligence layer, built in two halves.

Retrieval side first:
- Per-agent instantiation and session registry.
- Handshake: load operating rules from system namespace, build initial working memory brief.
- Relevance filtering: load what is relevant to the current task, not the full store.
- Two-pass retrieval: primary pass for directly relevant facts, secondary pass for peripheral facts.
- Context window observation: check what is already in the window before deciding what to inject.
- Checkpoint read and write.

Write side second:
- Stream observation: read the conversation stream and classify signal vs noise.
- Write routing: route signal to the Librarian without the agent calling any write tools.
- Reactive retrieval trigger: detect moments in the stream that warrant retrieval.
- Periodic drift check: configurable N-turn heartbeat that checks for stale context.
- Rules and preferences handling: store as distinct type, trigger on context match.

**Done when:** the Attendant retrieves relevant context bidirectionally — injecting on retrieval, routing on write — without the agent driving either side.

### Phase 4: The Archivist

Scheduled maintenance. Can be built largely in parallel with Phase 3 since it depends on Phase 2 but not on the Attendant.

- Scheduled scan cycle: archive expired facts, archive low-confidence facts.
- Memory decay: recalculate confidence based on lastAccessedAt and stability, archive facts that fall below threshold.
- Escalation file processing: read resolved markdown files, apply authoritative resolutions, move files.
- The `iranti resolve` CLI command for human conflict review.

**Done when:** the Archivist runs a full cycle, archives what should be archived, processes a resolved escalation file correctly, and the memory decay model is active.

### Phase 5: MCP integration and host testing

Connect the Attendant to real agent hosts via MCP and validate end-to-end behaviour.

- Design the MCP tool surface. In the rebuild this should be simpler than the current iranti — the agent streams context and receives injections, without manually calling write tools.
- Implement the MCP server over the Attendant.
- Integrate with Claude Code and validate a full session: stream in, memory builds, facts are retrieved and injected, corrections fire on drift.
- Integrate with one additional host (Codex or similar).
- End-to-end tests covering a multi-session project scenario.

**Done when:** a real agent session with Claude Code produces correctly stored facts, retrieves them in a later session, fires a rules injection when a preference is triggered, and survives a session interruption with backfill.

### Phase 6: CLI and SDK

Operational and integration surfaces.

- CLI: bind to a project, query memory, inspect facts, run diagnostics, run the Archivist manually, manage API keys.
- TypeScript SDK: expose the full API surface for agent builders.
- Python client: HTTP client for the REST API.

**Done when:** you can install iranti globally, bind it to a project, inspect what is in memory, and build a simple agent that uses the SDK to interact with iranti programmatically.

### Phase 7: Observability

Session ledger, metrics, and telemetry.

- Session ledger: write staff events with timestamps and reasons.
- Operational metrics: API error rates, latency, Archivist cycle results.
- Usage telemetry: opt-out behavioural metadata, installation identifier, project count, session frequency.
- Agent registry: profile, stats, whoKnows.
- Protocol enforcement: configurable handshake/attend cycle enforcement.

**Done when:** the session ledger records a full session's staff events, operational metrics are queryable, and the telemetry pipeline is running (even if no data is being collected yet from external installs).

### Deferred (not in scope for done enough)

- Apache AGE implementation switchover (development runs parallel from Phase 2, switchover when manual implementation shows limits)
- Cloud account and backup (requires its own spec first)
- Media storage — S3 backend and audio transcription (local-FS + semantic tagging shipped via OD-4, 2026-06-28; cloud storage backend and audio transcription remain deferred)
- Team collaboration and shared namespaces (requires access grant spec first)
- Cold start learning
- Dev mode

## 13. Open items

### Success criteria for iranti-core "done enough"

Iranti-core is done enough when the following are true.

The Attendant works bidirectionally: it surfaces relevant context from the stream on the retrieval side, and routes signal to the Librarian on the write side, without the agent calling any write tools manually.

Fact storage, retrieval, conflict detection, and resolution work correctly end-to-end. The Librarian detects conflicts, resolves what it can, and escalates what it cannot. The Archivist runs on schedule and archives expired and low-confidence facts.

Memory decay and Hebbian reinforcement are active. Facts lose confidence over time when not accessed. Graph edges strengthen when facts are retrieved together.

Rules and preferences fire correctly by context, not by similarity retrieval.

Session grouping is in place. Every fact is tagged with the session that produced it and time-based queries work.

The knowledge graph exists with at least the PostgreSQL manual implementation working. Traversal-based retrieval functions alongside direct lookup.

MCP integration works with at least Claude Code and one other host.

The CLI supports the minimum operational surface: binding iranti to a project, querying memory, running diagnostics.

Hybrid retrieval triggers are active: both reactive and periodic drift checks run and the correction-to-injection ratio is measurable.

The following are explicitly not required for done enough: cloud account and backup, full media storage (local-FS backend shipped via OD-4; S3 backend and audio transcription remain out of scope), Apache AGE implementation, team collaboration and shared namespaces, cold start learning, and dev mode.

### Open design decisions

**What exactly counts as the stream.** The Attendant observes the full conversation stream, but the definition of "stream" needs to be precise before building. Does it include tool call outputs? File contents read by the agent? Only user messages and agent responses? The answer affects what the Librarian receives and how much it has to filter.

**Periodic drift check frequency.** The N in "every N turns" is configurable but needs a default. Too low adds overhead on every few turns for no benefit. Too high lets drift accumulate. The right default will become clear through usage observation, but a starting value needs to be chosen and defended.

**Automatic relationship inference quality.** The graph builds connections automatically from temporal co-occurrence, entity overlap, and semantic similarity. The risk is noise: spurious connections that accumulate and degrade traversal quality. The Hebbian model handles this over time, but the initial inference rules need to be tight enough that the graph starts clean.

**Retrieval trigger in the MCP surface.** If the Attendant handles stream observation autonomously, the MCP tool surface simplifies: the agent provides the stream and receives injections, without manually calling write tools. The exact new tool surface needs to be designed before the MCP integration is built.

**Retrieval pass weighting and presentation.** Two retrieval passes run: primary (directly relevant) and secondary (peripheral, might matter). How these two tiers are weighted relative to each other and how they are presented back to the agent has not been decided. The host needs to know how to handle two tiers of results — whether they arrive together with different confidence scores, in separate blocks, or as a merged set with metadata indicating which tier each fact came from.

**Defining successful recall.** We have proxies (correction ratio, short sessions on existing projects) but no direct measurement. This remains an open problem. Worth revisiting once the system is live and real usage patterns are observable.

### Future features requiring their own specs before build

**Cloud account and backup.** Optional user account enabling cloud backup and cross-device sync. Requires a full privacy and encryption spec first, specifically the client-side decryption flow and key management design. High GDPR sensitivity.

**Media storage (S3 backend + audio transcription).** The local-FS backend, semantic tagging, and MCP ingest tool shipped via OD-4 (2026-06-28). Remaining future scope: S3-compatible cloud backend, audio transcription at ingest, and the escalation path from description to full media. Open questions that survived the OD-4 build: who decides when to re-inject actual media vs the description, and how audio transcription integrates at ingest time.

**Cold start learning.** A fresh iranti installation should learn like an LLM learns: from the people using it and from the system. What this means in practice, how long it takes, and how iranti bootstraps before it has accumulated context are all open. No decisions made yet.

**Team collaboration and shared namespaces.** Multiple users writing to a shared project namespace. Requires the detailed access grant and delegation model deferred from section 10 — specifically who can grant access and what happens when someone leaves.

**Cloud encryption architecture.** User-held keys means server-side intelligent retrieval is not possible on encrypted backups. Client-side decryption before the Attendant can reason over content is the implication. The full architecture of how this works in practice needs its own spec.

**GDPR compliance for commercial deployment.** Right-to-deletion implementation at the fact level. Formal data processing agreement template. Data residency considerations for European users.

### Risks worth tracking

**Automatic relationship inference noise.** If the graph builds too many spurious connections early on, traversal quality degrades and the system becomes less useful over time. Hebbian decay helps but the initial inference rules are the first line of defence.

**Context window observation reliability.** The Attendant's inject-or-stay-silent decision depends on knowing what is already in the agent's context window. If hosts do not surface this reliably, the Attendant either over-injects (redundant context) or misses corrections (stale context persists). This is a host-integration risk, not an iranti-internal one.

**Attendant write-routing quality.** If the Attendant misclassifies too much as noise, the knowledge store is sparse and recall suffers. If it routes too much as signal, the store fills with low-value facts and retrieval becomes noisy. This is the most consequential quality question in the whole system and it will require real usage data to tune.

**The manual edit problem.** When a user edits code or files directly outside an agent session, iranti has no visibility into that change. The agent's memory of the codebase becomes stale and can cause incorrect decisions. Possible directions include git integration, file watchers, or a sync mechanism. Needs a design decision before iranti-core ships to developers.

**Backfill when iranti is down.** When iranti is unavailable, agents keep working. When iranti reconnects it needs to know a gap occurred and process what it missed. The existing ingest path is the likely mechanism but the exact protocol for gap detection and retroactive processing is not yet specified.