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

import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import { rules, type NewRule, type Rule } from "../db/schema.js";
import { normalizeProjectId } from "./projects.js";
import { tokenizeMessage } from "./facts.js";

// ─── Situational relevance (Layer 0d) ────────────────────────────────────────
//
// A rule that is in scope (system/global, or an entity in the hints list) is
// not automatically injected on every attend() call — that is the "dumped
// every turn" failure mode the Layer 0d PRD exists to fix. When the caller
// provides a message, a rule is injected only if EITHER:
//
//   1. It is a critical/hard-constraint rule (priority >= CRITICAL_RULE_PRIORITY).
//      The existing priority-scale doc comment above already calls this tier
//      "critical (tone, safety, hard constraints)" — those apply on every
//      turn by the author's own declaration, not situationally.
//   2. The message shares at least one keyword token with the rule's text
//      (scoreRuleRelevance > 0) — deterministic, no embeddings, no LLM call
//      (G1). Reuses facts.ts's tokenizeMessage so "relevance" means the same
//      thing for facts and rules.
//
// With NO message (existing callers: rules.test.ts, projects-isolation.test.ts,
// mcp-tools.test.ts's no-message rules assertion), no filtering happens at all
// — exactly today's behavior. This mirrors readRelevantFactsByEntity's own
// "no message -> no filtering, fall back to unfiltered" contract and is what
// keeps every pre-Layer-0d test passing unchanged.
export const CRITICAL_RULE_PRIORITY = 100;

// Score a rule's relevance to a set of query tokens — keyword overlap against
// the rule's own free-text `text` field (rules have no separate key/value
// split the way facts do, so there is only one field to score against).
//
// The rule's text is tokenized with the SAME tokenizeMessage used for the
// query, and matching is set-membership (whole-token), not raw substring —
// a raw `ruleText.includes(t)` would match query token "button" inside rule
// text "buttons" (or worse, arbitrary short substrings inside unrelated
// words), which is exactly the over-eager-match failure class Layer 0c's
// alias resolver already had to guard against with boundary matching.
export function scoreRuleRelevance(rule: Pick<Rule, "text">, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const ruleTokens = new Set(tokenizeMessage(rule.text));
  let score = 0;
  for (const t of tokens) {
    if (ruleTokens.has(t)) score += 1;
  }
  return score;
}

// Situational relevance gate. Exported for direct unit testing independent of
// the DB round-trip in getRulesForAttend.
export function isRuleSituationallyRelevant(
  rule: Pick<Rule, "text" | "priority">,
  tokens: string[],
): boolean {
  if (rule.priority >= CRITICAL_RULE_PRIORITY) return true;
  return scoreRuleRelevance(rule, tokens) > 0;
}

// See facts.ts's projectFilter — same rationale: a single-element effective
// set degenerates to a plain equality, and every id is normalized so a
// caller-supplied path always lands on the same scope as the resolver's own
// (already-normalized) output.
function projectFilter(project: string | string[]) {
  const ids = Array.isArray(project) ? project : [project];
  const normalized = ids.map(normalizeProjectId);
  return normalized.length === 1
    ? eq(rules.project, normalized[0]!)
    : inArray(rules.project, normalized);
}

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
    | "project"
    | "agentId"
    | "sessionId"
    | "metadata"
  >,
): Promise<Rule> {
  const [rule] = await db
    .insert(rules)
    .values({
      ...input,
      project: normalizeProjectId(input.project ?? "default"),
      isActive: true,
    })
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
  project: string | string[] = "default",
): Promise<Rule[]> {
  return db.query.rules.findMany({
    where: and(
      eq(rules.tenantId, tenantId),
      projectFilter(project),
      eq(rules.entityType, entityType),
      eq(rules.entityId, entityId),
      eq(rules.isActive, true),
    ),
    orderBy: desc(rules.priority),
  });
}

// Layer 0h: list every rule in a project scope, active-only by default —
// the audit surface behind iranti_rules_list ("what is governing me right
// now?"). Unlike getRulesForEntity this spans ALL entities in scope: a host
// auditing its rules doesn't know which entities carry them. Ordered
// priority DESC then createdAt DESC for a stable, meaningful listing.
export async function listRulesForProject(
  tenantId: string = "default",
  project: string | string[] = "default",
  includeInactive = false,
): Promise<Rule[]> {
  const conditions = [eq(rules.tenantId, tenantId), projectFilter(project)];
  if (!includeInactive) conditions.push(eq(rules.isActive, true));
  return db.query.rules.findMany({
    where: and(...conditions),
    orderBy: [desc(rules.priority), desc(rules.createdAt)],
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
// Layer 0 (D7): "system/global" means global WITHIN a project, not across
// all projects on the install — isolation is the default, and a rule
// written while in project A firing in project B would be exactly the kind
// of cross-project leak the PRD's adversarial isolation tests target. So
// this whole query (including the system/global branch) is scoped by the
// effective project set like every other retrieval path; there is no
// install-wide "global rules" concept in Layer 0.
//
// Layer 0d: `message`, when provided, activates situational relevance
// filtering (see isRuleSituationallyRelevant above) — a rule below the
// critical-priority floor is returned only if it shares a keyword with the
// message. Omitting `message` (the default) returns every entity-scoped
// active rule unfiltered, exactly as before Layer 0d — this is what keeps
// every pre-existing caller (rules.test.ts, projects-isolation.test.ts,
// mcp-tools.test.ts's no-message case) unchanged.
export async function getRulesForAttend(
  entityHints: Array<{ entityType: string; entityId: string }>,
  tenantId: string = "default",
  project: string | string[] = "default",
  message?: string,
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

  // Single query: active rules for this tenant + project matching any of the
  // scoped entities.
  const scoped = await db.query.rules.findMany({
    where: and(
      eq(rules.tenantId, tenantId),
      projectFilter(project),
      eq(rules.isActive, true),
      // or() with a single element works the same as that element alone.
      or(...entityConditions),
    ),
    orderBy: desc(rules.priority),
  });

  if (message === undefined) return scoped;

  // Situational relevance gate (Layer 0d). Priority order is preserved —
  // relevance is a pass/fail filter, not a re-sort — so among relevant rules
  // the existing priority-DESC contract still decides injection order.
  const tokens = tokenizeMessage(message);
  return scoped.filter((r) => isRuleSituationallyRelevant(r, tokens));
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

// Deactivate a rule. It will no longer be returned by getRulesForAttend.
// The record is kept — deactivation is not deletion. There is no reactivation
// path in Phase 0. To restore a rule, write a new one with the same text.
// Layer 0h: project-boundary-checked, mirroring archiveAlias/archiveFact —
// the unscoped form was the write-side twin of the Layer 0 F3 fact-UUID
// leak (any project could deactivate any other project's rule by raw id).
// When `project` is passed (the MCP tool always passes the effective/
// combined set, parity with archive.ts), an out-of-scope or unknown id
// returns false — indistinguishable on purpose. Omitting `project`
// preserves the unscoped internal/test behavior.
export async function deactivateRule(
  ruleId: string,
  tenantId: string = "default",
  project?: string | string[],
): Promise<boolean> {
  const existing = await db.query.rules.findFirst({
    where: and(eq(rules.id, ruleId), eq(rules.tenantId, tenantId)),
  });
  if (!existing || !existing.isActive) return false;

  if (project !== undefined) {
    const allowed = (Array.isArray(project) ? project : [project]).map(normalizeProjectId);
    if (!allowed.includes(existing.project)) return false;
  }

  await db
    .update(rules)
    .set({ isActive: false })
    .where(eq(rules.id, ruleId));
  return true;
}

// ---------------------------------------------------------------------------
// Inspect (no side effects — for tests and debugging)
// ---------------------------------------------------------------------------

export async function getRuleById(ruleId: string): Promise<Rule | undefined> {
  return db.query.rules.findFirst({
    where: eq(rules.id, ruleId),
  });
}
