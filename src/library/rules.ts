// Rule management — Phase 0
//
// Rules are behavioral constraints injected into an agent's context before
// it responds. They differ from facts in every important way:
//
//   Facts = observations about the world. One current value per key. Decay.
//   Rules = imperatives on how to behave. Additive. Never decay.
//
// Writing a rule twice does not replace the first — it creates two independent
// rules. There is no upsert. To update a rule's text, deactivate the old one
// and write a new one.
//
// Reading rules has no side effects. No access tracking, no counter increments.
// Rules are inert until iranti_attend activates them.
//
// ─── Triggering model ────────────────────────────────────────────────────────
//
// Every iranti_attend call provides a list of entity hints: which entities
// are in scope for this conversation turn. iranti uses those hints to decide
// which rules to inject:
//
//   system/global rules       → always injected (global preferences)
//   user/{id} rules           → injected whenever that user is in session
//   project/{id} rules        → injected when the project is in the hint list
//
// getRulesForAttend() implements this logic. iranti_attend (Phase 1) calls it.
// The agent never selects rules manually.
//
// ─── Priority ────────────────────────────────────────────────────────────────
//
// Rules are returned ordered by priority DESC. Higher priority rules appear
// first in the injection block — the agent reads them first. Suggested scale:
//
//   100+   critical (tone, safety, hard constraints)
//   50–99  strong preferences
//   1–49   soft preferences
//   0      default (no explicit ordering)

import { and, desc, eq, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import { rules, type NewRule, type Rule } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Write a new rule. Rules are additive — calling writeRule twice creates two
// independent rule records. To replace a rule, deactivate the old one and
// write a new one.
export async function writeRule(
  input: Pick<
    NewRule,
    | "entityType"
    | "entityId"
    | "text"
    | "source"
    | "priority"
    | "tenantId"
    | "agentId"
    | "sessionId"
    | "metadata"
  >,
): Promise<Rule> {
  const [rule] = await db
    .insert(rules)
    .values({ ...input, isActive: true })
    .returning();

  return rule!;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Get all active rules for a specific entity, ordered by priority DESC.
// This is a direct entity lookup — use getRulesForAttend for context injection.
export async function getRulesForEntity(
  entityType: string,
  entityId: string,
  tenantId: string = "default",
): Promise<Rule[]> {
  return db.query.rules.findMany({
    where: and(
      eq(rules.tenantId, tenantId),
      eq(rules.entityType, entityType),
      eq(rules.entityId, entityId),
      eq(rules.isActive, true),
    ),
    orderBy: desc(rules.priority),
  });
}

// Get all rules that should be injected for a given set of entity hints.
// This is the function iranti_attend calls — it owns the triggering logic.
//
// Always includes system/global rules regardless of hints.
// Also includes active rules for any entity in the provided hints list.
// Returns all matching rules ordered by priority DESC.
//
// entityHints: the entities currently in scope for this conversation turn.
//   Pass an empty array to get only system/global rules.
//
// Example:
//   getRulesForAttend([
//     { entityType: "user",    entityId: "nf"           },
//     { entityType: "project", entityId: "iranti-core"  },
//   ])
//   → returns: all system/global + all user/nf + all project/iranti-core rules
export async function getRulesForAttend(
  entityHints: Array<{ entityType: string; entityId: string }>,
  tenantId: string = "default",
): Promise<Rule[]> {
  // Always start with system/global. De-duplicate in case the caller
  // already included it in the hints list.
  const allEntities = [
    { entityType: "system", entityId: "global" },
    ...entityHints.filter(
      (h) => !(h.entityType === "system" && h.entityId === "global"),
    ),
  ];

  // Build one OR condition per entity in scope.
  const entityConditions = allEntities
    .map((e) =>
      and(eq(rules.entityType, e.entityType), eq(rules.entityId, e.entityId)),
    )
    .filter((c): c is SQL => c !== undefined);

  // Single query: active rules for this tenant matching any of the scoped entities.
  return db.query.rules.findMany({
    where: and(
      eq(rules.tenantId, tenantId),
      eq(rules.isActive, true),
      // or() with a single element works the same as that element alone.
      or(...entityConditions),
    ),
    orderBy: desc(rules.priority),
  });
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

// Deactivate a rule. It will no longer be returned by getRulesForAttend.
// The record is kept — deactivation is not deletion. There is no reactivation
// path in Phase 0. To restore a rule, write a new one with the same text.
export async function deactivateRule(ruleId: string): Promise<void> {
  await db
    .update(rules)
    .set({ isActive: false })
    .where(eq(rules.id, ruleId));
}

// ---------------------------------------------------------------------------
// Inspect (no side effects — for tests and debugging)
// ---------------------------------------------------------------------------

export async function getRuleById(ruleId: string): Promise<Rule | undefined> {
  return db.query.rules.findFirst({
    where: eq(rules.id, ruleId),
  });
}
