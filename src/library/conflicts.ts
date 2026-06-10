// Conflict detection — Phase 2b
//
// Two layers:
//
//   MINIMAL  — same-key: when a new write targets an existing (entity, key),
//              compare source reliability scores. If the existing source is
//              significantly more trusted (gap > ESCALATION_THRESHOLD), block
//              the write and create an escalation. Otherwise supersede normally.
//              Runs synchronously inside writeFact's transaction.
//
//   DEEP     — cross-key: after each write, check whether the new value
//              contradicts any other fact for the same entity. Heuristic in
//              Phase 2b (negation pattern + term match). Runs fire-and-forget,
//              never blocks the write. Increments comprehensionMetrics so the
//              signal is measurable without auto-resolving anything.
//
// The LLM is never in the resolution path. All decisions are deterministic
// and reproducible from the source_reliability table alone.

import { and, eq } from "drizzle-orm";
import fs from "fs/promises";
import path from "path";
import { db } from "../db/connection.js";
import { escalations, facts } from "../db/schema.js";
import type { Fact } from "../db/schema.js";
import {
  ESCALATION_THRESHOLD,
  getScore,
  recordOutcome,
} from "./source-reliability.js";

// ---------------------------------------------------------------------------
// Comprehension metrics — in-process counters
// Phase 2.5 will wire these into the attend_log table / health views.
// ---------------------------------------------------------------------------

export const comprehensionMetrics = {
  minimalConflictsChecked: 0,
  supersessions: 0,
  escalations: 0,
  deepConflictsDetected: 0,
};

// ---------------------------------------------------------------------------
// Minimal conflict detection (synchronous, runs inside writeFact)
// ---------------------------------------------------------------------------

export type ConflictOutcome = "no_conflict" | "supersede" | "escalate";

// Decide whether a new write should supersede the existing fact or be
// escalated. Returns "no_conflict" when values are identical.
export async function checkConflict(
  existing: Fact,
  newValue: string,
  newSource: string,
): Promise<ConflictOutcome> {
  if (existing.value === newValue) return "no_conflict";

  comprehensionMetrics.minimalConflictsChecked++;

  const [existingScore, newScore] = await Promise.all([
    getScore(existing.source),
    getScore(newSource),
  ]);

  if (existingScore - newScore > ESCALATION_THRESHOLD) {
    return "escalate";
  }

  return "supersede";
}

// Write an escalation: DB record + markdown file in IRANTI_ESCALATIONS_DIR.
// Called by writeFact when checkConflict returns "escalate".
export async function createEscalation(opts: {
  tenantId: string;
  entityType: string;
  entityId: string;
  key: string;
  existingFact: Fact;
  newValue: string;
  newSource: string;
  reason: string;
}): Promise<void> {
  comprehensionMetrics.escalations++;

  // DB record.
  await db.insert(escalations).values({
    tenantId: opts.tenantId,
    entityType: opts.entityType,
    entityId: opts.entityId,
    key: opts.key,
    existingFactId: opts.existingFact.id,
    existingValue: opts.existingFact.value,
    newValue: opts.newValue,
    existingSource: opts.existingFact.source,
    newSource: opts.newSource,
    reason: opts.reason,
    status: "pending",
  });

  // Markdown file for human review.
  const dir = process.env["IRANTI_ESCALATIONS_DIR"]
    ? path.resolve(process.env["IRANTI_ESCALATIONS_DIR"])
    : path.join(process.cwd(), "iranti-escalations");

  await fs.mkdir(dir, { recursive: true });

  const [existingScore, newScore] = await Promise.all([
    getScore(opts.existingFact.source),
    getScore(opts.newSource),
  ]);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = `${opts.entityType}-${opts.entityId}-${opts.key}`.replace(/[/\\]/g, "_");
  const filename = `${ts}-${slug}.md`.slice(0, 220);

  const md = [
    "# Conflict Escalation",
    "",
    `**Entity:** ${opts.entityType}/${opts.entityId}`,
    `**Key:** ${opts.key}`,
    `**Existing value:** ${opts.existingFact.value}`,
    `**New value:** ${opts.newValue}`,
    `**Existing source:** ${opts.existingFact.source} (reliability: ${existingScore.toFixed(2)})`,
    `**New source:** ${opts.newSource} (reliability: ${newScore.toFixed(2)})`,
    `**Reason:** ${opts.reason}`,
    "**Status:** pending review",
    "",
    "---",
    `*Created: ${new Date().toISOString()}*`,
    "*Resolve by editing this file and running `iranti resolve` (Phase 4)*",
  ].join("\n");

  await fs.writeFile(path.join(dir, filename), md, "utf-8");
}

// Record a supersession outcome: new source wins, old source loses.
// Called by writeFact after a supersede decision.
export async function recordSupersession(
  newSource: string,
  existingSource: string,
): Promise<void> {
  comprehensionMetrics.supersessions++;
  await recordOutcome(newSource, existingSource);
}

// ---------------------------------------------------------------------------
// Deep conflict detection (async, fire-and-forget, never blocks writes)
// ---------------------------------------------------------------------------

// Patterns that indicate a negation of a technology/term.
const NEGATION_RE = [
  /\bnot\s+(?:use|using)\s+(\w+)/i,
  /\bnever\s+(?:use|using)\s+(\w+)/i,
  /\bdecided\s+(?:not\s+to\s+use|against\s+using?)\s+(\w+)/i,
  /\bswitch(?:ing|ed)?\s+(?:from|away\s+from)\s+(\w+)/i,
  /\bdrop(?:ping|ped)?\s+(\w+)/i,
  /\bno\s+longer\s+(?:use|using)\s+(\w+)/i,
];

function extractNegatedTerm(value: string): string | null {
  for (const re of NEGATION_RE) {
    const m = value.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}

// Check whether `newValue` negates a term that appears affirmatively in any
// other fact for this entity. Increments comprehensionMetrics.deepConflictsDetected
// for each candidate contradiction found, but does NOT auto-resolve.
export async function runDeepConflictCheck(
  entityType: string,
  entityId: string,
  key: string,
  newValue: string,
  tenantId: string = "default",
): Promise<void> {
  const negatedTerm = extractNegatedTerm(newValue);
  if (!negatedTerm) return;

  const otherFacts = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.isArchived, false),
    ),
    limit: 50,
  });

  for (const f of otherFacts) {
    if (f.key === key) continue;
    if (f.value.toLowerCase().includes(negatedTerm)) {
      comprehensionMetrics.deepConflictsDetected++;
      console.error(
        `[iranti] deep conflict candidate: key="${key}" (value contains "not ${negatedTerm}") vs key="${f.key}" (contains "${negatedTerm}")`,
      );
    }
  }
}
