// iranti-core database schema — Phase 0
//
// This file is the single source of truth for the database structure.
// Drizzle reads it to generate migration files. TypeScript reads it to
// infer types for every query. Change it here, run `pnpm db:generate`,
// and the rest follows.
//
// Phase 0 tables: agents, sessions, entities, facts, fact_archive, rules
// Phase 2a tables: knowledge_edges
// Phase 2b tables: source_reliability, escalations
// Phase 2.5 tables: attend_log, metric_counters
// Phase 3 changes: attend_log.phase, metric_counters composite PK (tenant_id, name)
// Layer 0 (project scoping): facts/rules/knowledge_edges gain a `project`
// column (dedicated scope dimension, D6 — parallel to tenantId, never
// overloading it); new tables `projects` (registry) and `project_links`
// (combine). See docs/prds/phases/layer-0-foundation.md §11.
// Later phases add: relationships, entity_aliases, staff_events, tokens, users

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// agents
//
// Every writer of facts must be a registered agent. An agent is any AI host
// or process that iranti is connected to — a Claude Code session, a custom
// script, a scheduled job.
// ---------------------------------------------------------------------------
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Human-readable name for this agent. e.g. "claude-code", "my-python-script"
  name: text("name").notNull(),

  description: text("description"),

  registeredAt: timestamp("registered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Arbitrary extra data. Useful for storing the host type, version, etc.
  metadata: jsonb("metadata"),
});

// ---------------------------------------------------------------------------
// sessions
//
// A session groups everything that happens in one continuous interaction —
// one Claude Code session, one API call chain, etc. Facts written during a
// session are tagged with its ID so they can be queried by time.
// ---------------------------------------------------------------------------
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Which agent started this session.
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),

  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Null until the session is closed.
  endedAt: timestamp("ended_at", { withTimezone: true }),

  metadata: jsonb("metadata"),

  // CORE-17: per-session attend counter, incremented on every attend call.
  // Observability-only — written for turn-volume diagnostics but not read back
  // by the attend path. (Originally drove a drift heartbeat that was removed;
  // the column is retained as a cheap session-activity signal.)
  turnCount: integer("turn_count").notNull().default(0),
});

// ---------------------------------------------------------------------------
// entities
//
// The thing a fact is about. iranti namespaces everything by entity:
// project/my-app, user/alice, system/global.
//
// entityType: "project" | "user" | "system" (extensible)
// entityId:   the specific identifier within that type
// ---------------------------------------------------------------------------
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    entityType: text("entity_type").notNull(),

    entityId: text("entity_id").notNull(),

    // Optional human-readable label. e.g. "Alice's workspace"
    label: text("label"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // An entity is uniquely identified by its type + id pair.
    // You cannot have two "user/alice" entities.
    unique("entities_type_id_uniq").on(t.entityType, t.entityId),
  ],
);

// ---------------------------------------------------------------------------
// facts
//
// The core primitive. A fact is a piece of information about an entity:
//   { entityType: "user", entityId: "alice", key: "timezone", value: "UTC+1" }
//
// The unique constraint on (entityType, entityId, key) means an entity can
// only have one current value per key. Writing a new fact with the same
// (entityType, entityId, key) is an upsert — the old value is replaced.
//
// Confidence, stabilityScore, and accessCount support the memory decay and
// Hebbian reinforcement systems in Phase 4.
// ---------------------------------------------------------------------------
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenancy seam — always 'default' in Phase 0–4 (single-user).
    // Phase 5 (multi-user SaaS) populates this with the real tenant identifier.
    // Included in the unique constraint from day one so Phase 5 never needs to
    // perform a breaking constraint migration on a live, populated table.
    tenantId: text("tenant_id").notNull().default("default"),

    // Layer 0 (D6): dedicated project scope — a folder-derived identity
    // (git-root, Projects-root child, or fallback cwd; see
    // src/library/projects.ts), NOT the tenant. Defaults to "default" so
    // every pre-existing caller/test is unaffected until it opts into real
    // project resolution via McpContext. Isolation is enforced by including
    // this column in the unique constraint and in every retrieval filter.
    project: text("project").notNull().default("default"),

    // Which entity this fact is about.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),

    // The fact's name within the entity. e.g. "timezone", "preferred_language"
    key: text("key").notNull(),

    // The fact's content. Always stored as text.
    value: text("value").notNull(),

    // How confident iranti is in this fact. 0.0–1.0.
    // Starts at 1.0 on write. Decreases over time via memory decay (Phase 4).
    confidence: real("confidence").notNull().default(1.0),

    // What wrote this fact. e.g. "attendant", "librarian", "user"
    source: text("source").notNull(),

    // Which AI host surface wrote this fact.
    // Tracks cross-platform provenance from day one — every fact knows where it came from.
    // Allowed values: "claude" | "chatgpt" | "gemini" | "deepseek" | "dev_cli" | "web_ui" | "manual"
    // Nullable for facts written outside a known surface (scripts, tests, etc.).
    surface: text("surface"),

    // Which session this fact was written in. Nullable for system-written facts.
    sessionId: uuid("session_id").references(() => sessions.id),

    // Which agent wrote this fact.
    agentId: uuid("agent_id").references(() => agents.id),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Updated on every write to this row (value change, source update, etc.).
    // Distinct from lastAccessedAt — reads do not change updatedAt.
    // Answers "when was this fact last written?" without querying fact_archive.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Updated every time this fact is retrieved. Used to calculate memory decay.
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // A score that slows decay for well-established facts.
    // Increased by Hebbian reinforcement (Phase 4) when this fact is
    // retrieved alongside other facts repeatedly.
    stabilityScore: real("stability_score").notNull().default(1.0),

    // How many times this fact has been retrieved. Informs reinforcement.
    accessCount: integer("access_count").notNull().default(0),

    // Protected facts cannot be overwritten by a normal writeFact call.
    // Use this to guard important facts against accidental agent overwrites.
    // Note: behavioral rules belong in the `rules` table, not here with isProtected.
    // Only an explicit admin operation (Phase 2) can change a protected fact.
    isProtected: boolean("is_protected").notNull().default(false),

    // Soft-deleted flag. Archived facts are kept for audit purposes but
    // excluded from normal retrieval. Hard deletion is not allowed.
    // When archiving, the current value is first copied to fact_archive.
    isArchived: boolean("is_archived").notNull().default(false),

    metadata: jsonb("metadata"),

    // CORE-16 (Phase 3): dense embedding for the semantic retrieval tier
    // (bottom rung, slot-fill only — strictly subordinate to exact/keyword;
    // see docs/prds/phases/core-16-semantic-retrieval.md). Null until an
    // embedder is configured (env `IRANTI_EMBEDDER=off|ollama`, default
    // off — supersedes the never-wired `IRANTI_EMBEDDINGS` name this
    // comment used to reference). Dimension 768 matches the default local
    // model (nomic-embed-text via Ollama). Holds ONLY the raw vector — the
    // regime signature {model, dim, v} that guards against cross-model
    // cosine rides in `metadata.embedRegime` instead (both engines), so this
    // column can stay a pure vector(768) on Postgres. Never read/written
    // through Drizzle's typed column directly — src/embed/vector-column.ts
    // is the one accessor, so no caller branches on engine (native pgvector
    // on Postgres, JSON-serialized number[] text on PGlite).
    embedding: vector("embedding", { dimensions: 768 }),
  },
  (t) => [
    // One current value per (tenant, project, entity, key). Writing to the
    // same key within the same tenant+project is an upsert. Different
    // projects (like different tenants) can hold independent values for the
    // same entity+key combination — this is the isolation-by-default
    // guarantee (Layer 0, D7).
    unique("facts_tenant_project_entity_key_uniq").on(
      t.tenantId,
      t.project,
      t.entityType,
      t.entityId,
      t.key,
    ),
    // CORE-16: HNSW index for approximate nearest-neighbour search.
    // ef_construction / m use pgvector defaults; tune after benchmarking real data.
    // NULL embeddings are not indexed, so while embeddings are disabled every
    // fact write skips this index entirely — it adds no write cost until the
    // column is actually populated (IRANTI_EMBEDDINGS=true).
    index("facts_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ---------------------------------------------------------------------------
// fact_archive
//
// An append-only history table. Every time a fact's value is replaced
// (via writeFact upsert) or a fact is manually archived (via archiveFact),
// a snapshot of the fact at that moment is written here.
//
// This is how you trace a fact through time:
//   - Query fact_archive by factId, ordered by archivedAt DESC.
//   - The newest row is the most recent value before the current one.
//
// This table is never updated, only inserted into.
// ---------------------------------------------------------------------------
export const factArchive = pgTable(
  "fact_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The fact this row is a snapshot of. Points to a live row in facts.
    // The live fact is always the current value; all previous values live here.
    factId: uuid("fact_id")
      .notNull()
      .references(() => facts.id),

    // Tenancy seam — copied from the fact at snapshot time.
    // Required to make getFactHistoryByKey() tenant-safe without a join.
    tenantId: text("tenant_id").notNull().default("default"),

    // Denormalized identity columns from the fact at snapshot time.
    // Stored here so you can query history without joining to facts.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    key: text("key").notNull(),

    // The value at the time this snapshot was taken (i.e. the OLD value,
    // the one that was just replaced or archived).
    value: text("value").notNull(),

    confidence: real("confidence").notNull(),
    source: text("source").notNull(),
    surface: text("surface"),

    sessionId: uuid("session_id"),
    agentId: uuid("agent_id"),

    // Access/stability metrics at snapshot time — useful for decay diagnostics.
    stabilityScore: real("stability_score").notNull(),
    accessCount: integer("access_count").notNull(),

    metadata: jsonb("metadata"),

    // When this snapshot was taken.
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Why this snapshot was taken.
    // "superseded"                 — writeFact replaced the value with a new one
    // "archived_by_user"           — archiveFact() was called explicitly
    // "superseded_by_correction"   — Layer 0i: an extracted correction:* fact
    //                                unambiguously named this fact and archived it
    archivedReason: text("archived_reason").notNull(),
  },
  (t) => [
    // Primary history query: all snapshots for a specific fact, newest first.
    index("fact_archive_fact_id_idx").on(t.factId, t.archivedAt),
    // History by tenant + entity + key — used by getFactHistoryByKey().
    index("fact_archive_entity_key_idx").on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.key,
      t.archivedAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// rules
//
// Behavioral constraints on agents. Rules are injected into context by
// iranti_attend before an agent responds, so the agent knows how to behave.
//
// Rules differ fundamentally from facts:
//
//   FACTS are observations:   { key: "timezone", value: "UTC+1" }
//   RULES are imperatives:    "always respond in English"
//
//   Facts have one current value per key — writes are upserts.
//   Rules are additive — multiple rules can coexist for the same entity.
//
//   Facts decay over time (Phase 4). Rules do not.
//   Reading a fact has side effects (access tracking). Reading rules does not.
//
// Triggering model (implemented in Phase 1):
//   iranti_attend receives a list of entity hints (which entities are in
//   scope for this conversation turn). It pulls:
//
//     1. ALL active rules scoped to system/global  — always injected
//     2. ALL active rules for any entity in the hints list
//
//   Rules are returned ordered by priority DESC so critical rules appear
//   first in the context injection block. The agent never picks rules
//   manually — iranti decides what is relevant.
//
// Entity scoping convention:
//   system/global     — fires on every iranti_attend call regardless of context
//   user/{id}         — fires whenever that user is the active user in session
//   project/{id}      — fires when that project is among the entity hints
// ---------------------------------------------------------------------------
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenancy seam — see facts.tenantId for the full explanation.
    // Rules are tenant-scoped: each tenant has their own set of rules,
    // including their own system/global rules.
    tenantId: text("tenant_id").notNull().default("default"),

    // Layer 0 (D6): dedicated project scope — see facts.project for the
    // full explanation. Rules are project-scoped the same way facts are:
    // a rule written in project A does not fire for project B unless
    // explicitly combined.
    project: text("project").notNull().default("default"),

    // Which entity this rule is scoped to.
    // See entity scoping convention above.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),

    // The rule in plain natural language. No key-value format — rules are
    // full sentences that agents can read and follow directly.
    // e.g. "never use em dashes in any response"
    // e.g. "assume I am a product manager, not a developer"
    // e.g. "always check implementation.md before writing code"
    text: text("text").notNull(),

    // Whether this rule is currently active.
    // Deactivated rules are not injected by iranti_attend.
    // The record is kept for history. To re-activate, write a new rule.
    isActive: boolean("is_active").notNull().default(true),

    // Injection order within a context block. Higher = appears first.
    // Critical constraints should be 100+. Normal preferences default to 0.
    priority: integer("priority").notNull().default(0),

    // What wrote this rule. e.g. "user", "claude-code", "setup-wizard"
    source: text("source").notNull(),

    // Which agent wrote this rule.
    agentId: uuid("agent_id").references(() => agents.id),

    // Which session this rule was written in.
    sessionId: uuid("session_id").references(() => sessions.id),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    metadata: jsonb("metadata"),
  },
  (t) => [
    // Primary query: all active rules for a given entity, priority-ordered.
    index("rules_entity_active_idx").on(t.entityType, t.entityId, t.isActive),
    // Layer 0: project-scoped variant of the same lookup.
    index("rules_project_entity_active_idx").on(
      t.project,
      t.entityType,
      t.entityId,
      t.isActive,
    ),
  ],
);

// ---------------------------------------------------------------------------
// knowledge_edges — Phase 2a
//
// The graph substrate. An edge connects two nodes (facts, rules, or entities)
// with a labelled relation and a weight that accumulates over time.
//
// Relations in use:
//   co_access — two facts returned together in the same attend. Weight =
//               how many times they co-occurred. Stored with canonical pair
//               ordering so (A,B) and (B,A) are the same row.
//   governs   — directed edge rule→fact. A rule co-fired with a fact in an
//               attend. Groundwork for graph-proximity rule triggering (Phase 3).
//
// The weight column is raw accumulation (Phase 2a). Normalization and
// decay are deferred to Phase 3 and Phase 4 respectively.
//
// Edge writes are best-effort and never block or fail core read/write paths.
// ---------------------------------------------------------------------------
export const knowledgeEdges = pgTable(
  "knowledge_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenancy seam — always 'default' until Phase 5.
    tenantId: text("tenant_id").notNull().default("default"),

    // Layer 0 (D6): dedicated project scope — see facts.project. An edge
    // recorded while attending to project A must never surface a project-B
    // node as a "related" suggestion (peripheral/graph-hop retrieval).
    project: text("project").notNull().default("default"),

    // Source node. 'fact' | 'rule' | 'entity'
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),

    // Target node. 'fact' | 'rule' | 'entity'
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),

    // What kind of connection this is. 'co_access' | 'governs'
    relation: text("relation").notNull(),

    // Accumulated weight. Incremented by reinforceEdge on each co-access.
    weight: real("weight").notNull().default(1),

    // How many times these two nodes were retrieved together.
    coAccessCount: integer("co_access_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    lastReinforcedAt: timestamp("last_reinforced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Canonical-pair uniqueness: one row per (tenant, project, src, tgt, relation).
    // co_access edges are stored with canonical ordering (smaller key first)
    // so there is never a duplicate (A→B, B→A) pair for the same relation.
    unique("knowledge_edges_canonical_pair_uniq").on(
      t.tenantId,
      t.project,
      t.sourceType,
      t.sourceId,
      t.targetType,
      t.targetId,
      t.relation,
    ),
    // Primary neighbour lookup: "who did this node co-occur with?"
    index("knowledge_edges_source_idx").on(t.sourceType, t.sourceId),
    // Reverse neighbour lookup: needed for undirected traversal.
    index("knowledge_edges_target_idx").on(t.targetType, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// source_reliability — Phase 2b / 2.5
//
// Tracks the track record of each fact source. A source that consistently
// wins conflict resolutions earns a higher score; a source that consistently
// loses earns a lower score. This score is used as a confidence weight on
// subsequent writes, so trusted sources accumulate trust automatically.
//
// score = wins / (wins + losses), initialised to 0.5 (neutral).
// Updated on each conflict resolution — not on every write.
//
// Phase 2.5 (CORE-28): added tenant_id so reliability scores are scoped per
// tenant. Composite PK (tenant_id, source) matches the seam every other table
// has carried since Phase 0. Existing rows migrate to tenant_id = 'default'.
// ---------------------------------------------------------------------------
export const sourceReliability = pgTable(
  "source_reliability",
  {
    tenantId: text("tenant_id").notNull().default("default"),
    source: text("source").notNull(),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    score: real("score").notNull().default(0.5),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.source] })],
);

// ---------------------------------------------------------------------------
// escalations — Phase 2b
//
// When a conflicting write cannot be auto-resolved (the existing source is
// significantly more trusted), the write is blocked and the conflict is
// recorded here AND in a human-readable markdown file. Phase 4 adds
// `iranti resolve` to apply human decisions.
// ---------------------------------------------------------------------------
export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull().default("default"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  key: text("key").notNull(),
  existingFactId: uuid("existing_fact_id"),
  existingValue: text("existing_value").notNull(),
  newValue: text("new_value").notNull(),
  existingSource: text("existing_source").notNull(),
  newSource: text("new_source").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// attend_log — Phase 2.5 (CORE-14)
//
// One row per iranti_attend call: behavioral metadata only (counts, sizes,
// latency). Never stores the content of a fact, conversation, or session —
// master PRD §11 hard constraint. Written fire-and-forget after the response
// is assembled so attend latency is unchanged.
//
// "tokens saved this week" = SUM(suppressed_tokens_est) WHERE created_at > now()-7d
// ---------------------------------------------------------------------------
export const attendLog = pgTable(
  "attend_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().default("default"),
    sessionId: uuid("session_id"),
    agentId: uuid("agent_id"),
    surface: text("surface"),
    factCount: integer("fact_count").notNull().default(0),
    ruleCount: integer("rule_count").notNull().default(0),
    alreadyPresent: integer("already_present").notNull().default(0),
    injectedChars: integer("injected_chars").notNull().default(0),
    // Token estimates use chars / 4 (D2: model-agnostic, no tokenizer dep).
    injectedTokensEst: integer("injected_tokens_est").notNull().default(0),
    suppressedTokensEst: integer("suppressed_tokens_est").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    // Phase 3 (CORE-31): lifecycle phase that produced this attend call.
    phase: text("phase"),
    // Phase 3 (CORE-32): facts written by server-side extraction this attend.
    factsExtracted: integer("facts_extracted").notNull().default(0),
    // CORE-17: how many stale-context corrections were emitted this attend.
    correctionsCount: integer("corrections_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attend_log_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// metric_counters — Phase 2.5 (CORE-14)
//
// Persists comprehension metrics across process restarts. Each counter is one
// row keyed by name. Updated fire-and-forget on every attend so the counters
// accumulate across sessions without requiring the process to stay up.
//
// Current keys: minimalConflictsChecked, supersessions, escalations,
//               deepConflictsDetected
// ---------------------------------------------------------------------------
// Phase 3 (D4): composite PK (tenant_id, name) so counters are per-tenant.
// Existing rows migrate to tenant_id = 'default'.
export const metricCounters = pgTable(
  "metric_counters",
  {
    tenantId: text("tenant_id").notNull().default("default"),
    name: text("name").notNull(),
    value: integer("value").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

// ---------------------------------------------------------------------------
// Inferred TypeScript types
//
// Drizzle derives these from the schema above. Use them everywhere instead
// of writing types by hand — they stay in sync automatically.
// ---------------------------------------------------------------------------
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;

export type FactArchive = typeof factArchive.$inferSelect;
export type NewFactArchive = typeof factArchive.$inferInsert;

export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;

export type KnowledgeEdge = typeof knowledgeEdges.$inferSelect;
export type NewKnowledgeEdge = typeof knowledgeEdges.$inferInsert;

export type SourceReliability = typeof sourceReliability.$inferSelect;
export type NewSourceReliability = typeof sourceReliability.$inferInsert;

export type Escalation = typeof escalations.$inferSelect;
export type NewEscalation = typeof escalations.$inferInsert;

export type AttendLog = typeof attendLog.$inferSelect;
export type NewAttendLog = typeof attendLog.$inferInsert;

export type MetricCounter = typeof metricCounters.$inferSelect;
export type NewMetricCounter = typeof metricCounters.$inferInsert;

// ---------------------------------------------------------------------------
// media_objects — Phase 3 (CORE-30)
//
// Schema-only. No read/write path in Phase 3.
// Retrieval (CORE-15/16) will consume this in a future phase once ingest
// behavior has its own spec (master PRD §13).
//
// One row = one external media object (image, document, recording, etc.)
// associated with an entity at a specific semantic slot (key). The object
// lives at object_url; iranti holds the pointer and the description — never
// the binary.
//
// mime_type: IANA media type, e.g. "image/png", "application/pdf".
// key: semantic slot, e.g. "diagram:architecture", "screenshot:login-flow".
// description_text: plain-text caption/description for keyword retrieval.
// ---------------------------------------------------------------------------
export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    tenantId: text("tenant_id").notNull().default("default"),

    // Layer 0 (D6): dedicated project scope — see facts.project. Added
    // (unlike most other audit/telemetry tables — see PRD §11.1) because
    // media_objects DOES have a live retrieval reader: iranti_attend's
    // media tier (OD-4, mcp/tools/attend.ts) calls searchMedia() scoped only
    // by entityType/entityId, which can collide across projects (e.g. the
    // same "project/my-app" entity name reused by two unrelated folders) —
    // without this column that call site would be a real cross-project leak.
    project: text("project").notNull().default("default"),

    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),

    key: text("key").notNull(),

    objectUrl: text("object_url").notNull(),
    mimeType: text("mime_type").notNull(),

    descriptionText: text("description_text"),

    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("media_objects_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("media_objects_project_entity_idx").on(t.project, t.entityType, t.entityId),
  ],
);

export type MediaObject = typeof mediaObjects.$inferSelect;
export type NewMediaObject = typeof mediaObjects.$inferInsert;

// ---------------------------------------------------------------------------
// extraction_cache — AX-2
//
// Durable content-hash cache for the LLM extractor. Caches the full merged
// ExtractedFact[] so repeated extractions of the same input under the same
// regime are deterministic and free (zero LLM calls on hit).
//
// Cache key = composite PK (tenant_id, input_hash, regime_signature).
// Entries are permanent (no TTL) — busted by a regime change (model, prompt,
// normalizer version), never by time.
//
// Only the LLM extractor path uses this; the heuristic extractor is already
// pure/deterministic and would gain nothing from a cache round-trip.
// ---------------------------------------------------------------------------
export const extractionCache = pgTable(
  "extraction_cache",
  {
    // Tenancy seam — consistent with every other table.
    tenantId: text("tenant_id").notNull().default("default"),

    // SHA-256 hex of normalizeForCache(rawText). Never stores the raw text.
    inputHash: text("input_hash").notNull(),

    // "{extractorMode}|{modelId}|{promptVersion}|{normalizerVersion}"
    // Any dimension change → guaranteed miss, never a stale hit.
    regimeSignature: text("regime_signature").notNull(),

    // Cached output: the full merged ExtractedFact[] after heuristic+LLM merge.
    result: jsonb("result").notNull(),

    // Denormalized from signature for queryability/audit.
    extractorMode: text("extractor_mode").notNull(),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    normalizerVersion: text("normalizer_version").notNull(),

    // Best-effort observability — never read by the extract path.
    hitCount: integer("hit_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.inputHash, t.regimeSignature] }),
  ],
);

export type ExtractionCache = typeof extractionCache.$inferSelect;
export type NewExtractionCache = typeof extractionCache.$inferInsert;

// ---------------------------------------------------------------------------
// projects — Layer 0 (folder-scoped projects, D5/D6/D8)
//
// The project registry. `id` is the deterministic project identifier computed
// by src/library/projects.ts (git-root path, Projects-root child path, or
// fallback cwd path — see docs/prds/phases/layer-0-foundation.md §11.2). Rows
// are auto-upserted (get-or-create) the first time a project id is resolved
// in a process — no manual registration step, matching the zero-config
// default (D8). New subfolders auto-register on first call (D5).
//
// isExcluded: set by iranti_project_exclude / the exclude() library call.
// An excluded project still resolves and still works (D8 spirit — excluding
// a folder isn't a crash), but is treated as isolated with no combine links
// honored, and its writes are tagged for audit (see §11.4 of the PRD).
// Reversible via iranti_project_include — never a row deletion (G1).
// ---------------------------------------------------------------------------
export const projects = pgTable("projects", {
  // The normalized, deterministic project id (an absolute filesystem path).
  id: text("id").primaryKey(),

  // Optional human-readable label. Not currently settable via any tool —
  // schema pre-placement for a future `iranti project label` command.
  label: text("label"),

  // How this project id was derived. One of "git-root" |
  // "projects-root-child" | "fallback". Audit/debugging aid — lets a user
  // (or a future `iranti project status`) explain WHY a folder got the id
  // it did.
  source: text("source").notNull(),

  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  // See header comment. Default false — a project is included the moment
  // it's first seen.
  isExcluded: boolean("is_excluded").notNull().default(false),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;

// ---------------------------------------------------------------------------
// project_links — Layer 0 (explicit combine, D7)
//
// A row means "projectA and projectB share memory while isActive" — combine
// is symmetric (A sees B's facts/rules, and B sees A's), stored as ONE row
// and read in both directions by src/library/projects.ts's
// getEffectiveProjectIds(). Canonical ordering (projectA is always the
// lexicographically smaller id) is enforced in application code, not a DB
// constraint (Drizzle/pg-core has no portable LEAST/GREATEST expression
// index, and PGlite's DDL surface is the more constrained of the two
// engines — see PRD §11.1) — combineProjects() in projects.ts is the only
// writer and always normalizes the pair before insert/lookup.
//
// Reversing a combine sets isActive = false and stamps deactivatedAt. The
// row is never deleted (G1) — history of past combines is preserved and
// re-combining the same pair re-activates the existing row rather than
// creating a duplicate.
// ---------------------------------------------------------------------------
export const projectLinks = pgTable(
  "project_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Canonical ordering: projectA < projectB lexicographically. Enforced by
    // combineProjects(), not the DB (see header comment).
    projectA: text("project_a").notNull(),
    projectB: text("project_b").notNull(),

    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Null while the link has never been reversed. Set on deactivation;
    // cleared back to null on re-activation so it always reflects the
    // MOST RECENT deactivation, not the first.
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [
    // A given (projectA, projectB) pair should have at most one row —
    // combineProjects() looks up both orderings before inserting (app-level
    // canonicalization, see header) and this constraint backstops that at
    // the DB level for the canonical ordering itself.
    unique("project_links_pair_uniq").on(t.projectA, t.projectB),
    index("project_links_a_idx").on(t.projectA, t.isActive),
    index("project_links_b_idx").on(t.projectB, t.isActive),
  ],
);

export type ProjectLink = typeof projectLinks.$inferSelect;
export type NewProjectLink = typeof projectLinks.$inferInsert;

// ---------------------------------------------------------------------------
// entity_aliases — Layer 0c (entity resolution, the "textbook" fix)
//
// A durable link from an alias phrase ("the figma file") to the fact it
// resolves to, scoped per entity. Learned ONCE (heuristic, deterministic —
// see src/extract/index.ts's ALIAS_PATTERNS) from an explicit declarative
// signal in a message, then applied at every retrieval thereafter via exact
// stored-alias lookup (src/library/aliases.ts's resolveAlias) — never fuzzy/
// embedding similarity (G1 determinism).
//
// factKey (not factId) is the stored pointer: resolving to "the live fact
// for this entity+key" means an alias survives its target fact being
// superseded (a new value written to the same key) without needing to be
// re-learned — the same durable-identity treatment every other part of
// iranti gives (entityType, entityId, key).
//
// Layer 0 (D6/D7): project-scoped exactly like facts/rules/knowledge_edges.
// An alias learned in project A must not resolve in project B — resolving
// across the boundary would leak the existence/content of a project-private
// fact, which is exactly what getFactById's project-scoped guard exists to
// prevent for direct id lookups. An alias must not become a side-door
// around that guard. See docs/prds/phases/layer-0c-entity-resolution.md §11.6-equivalent.
//
// Never hard-deleted (G1): archiveAlias() sets isActive = false, matching
// rules.deactivateRule / facts.archiveFact's posture exactly.
// ---------------------------------------------------------------------------
export const entityAliases = pgTable(
  "entity_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    tenantId: text("tenant_id").notNull().default("default"),
    project: text("project").notNull().default("default"),

    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),

    // Normalized (lowercased, whitespace-collapsed) alias phrase — the
    // lookup key at resolve time.
    alias: text("alias").notNull(),

    // Original phrasing as written, preserved for provenance/display —
    // mirrors keys.ts's rawKey pattern for facts.
    rawAlias: text("raw_alias").notNull(),

    // The normalized key of the fact this alias resolves to (NOT a fact id
    // — see header comment on why this follows supersession).
    factKey: text("fact_key").notNull(),

    // What learned this alias. Layer 0c only ever writes "extractor_heuristic".
    source: text("source").notNull(),

    confidence: real("confidence").notNull().default(0.85),

    // Deactivated aliases are not applied by resolveAlias. The record is
    // kept (G1) — archiveAlias() is the only way to retire one.
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One target per alias per entity per project — re-learning the SAME
    // alias text for the same entity is an upsert (see learnAlias), not a
    // duplicate row.
    unique("entity_aliases_tenant_project_entity_alias_uniq").on(
      t.tenantId,
      t.project,
      t.entityType,
      t.entityId,
      t.alias,
    ),
    // Primary resolve-path lookup: "does this entity have any active
    // aliases in this project?"
    index("entity_aliases_lookup_idx").on(
      t.tenantId,
      t.project,
      t.entityType,
      t.entityId,
      t.isActive,
    ),
  ],
);

export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
