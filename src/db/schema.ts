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
  },
  (t) => [
    // One current value per (tenant, entity, key). Writing to the same key
    // within the same tenant is an upsert. Different tenants can hold
    // independent values for the same entity+key combination.
    unique("facts_tenant_entity_key_uniq").on(t.tenantId, t.entityType, t.entityId, t.key),
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
    // "superseded"       — writeFact replaced the value with a new one
    // "archived_by_user" — archiveFact() was called explicitly
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
    // Canonical-pair uniqueness: one row per (tenant, src, tgt, relation).
    // co_access edges are stored with canonical ordering (smaller key first)
    // so there is never a duplicate (A→B, B→A) pair for the same relation.
    unique("knowledge_edges_canonical_pair_uniq").on(
      t.tenantId,
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
