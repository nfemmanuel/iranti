// iranti-core
// Automatic context engineering for AI agents.
//
// Public API surface for Phase 0.
// Import from here, not from internal modules directly.
//
// Tables:     agents, sessions, entities, facts, fact_archive, rules
// Key types:  Agent, Session, Entity, Fact, FactArchive, Rule (+ New* variants)
// Key ops:    writeFact, readFact, readFactsByEntity, archiveFact,
//             getFactHistory, getFactHistoryByKey,
//             writeRule, getRulesForAttend, getRulesForEntity, deactivateRule,
//             registerAgent, openSession, closeSession, upsertEntity

export { db } from "./db/connection.js";
export * from "./db/schema.js";
export * from "./library/agents.js";
export * from "./library/sessions.js";
export * from "./library/entities.js";
export * from "./library/facts.js";
export * from "./library/rules.js";
