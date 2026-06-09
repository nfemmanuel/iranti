// iranti-core database schema — Phase 0
//
// This file is the single source of truth for the database structure.
// Drizzle reads it to generate migration files. TypeScript reads it to
// infer types for every query. Change it here, run `pnpm db:generate`,
// and the rest follows.
//
// Phase 0 tables: agents, sessions, entities, facts, fact_archive, rules
// Later phases add: relationships, entity_aliases, staff_events, tokens, users

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
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
    // One current value per (entity, key). Writing to the same key is an upsert.
    unique("facts_entity_key_uniq").on(t.entityType, t.entityId, t.key),
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
    // History by entity + key — useful when you don't know the factId yet.
    index("fact_archive_entity_key_idx").on(
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
