// iranti_attend — Phase 1
//
// The core bidirectional call. The host calls this before responding:
//
//   WRITE side: deterministic artifacts (URLs, file paths) are extracted
//   from the incoming message and stored as facts — the host doesn't have
//   to remember to store anything.
//
//   READ side: relevant rules, recent facts, and the active checkpoint for
//   the entities in scope are returned for injection into the host's context.
//
// The response is bounded: at most MAX_FACTS_PER_ENTITY facts per entity
// hint and MAX_TOTAL_FACTS overall. Facts are relevance-ranked: keyword
// overlap between the message and fact key/value scores first, with recency
// as a tiebreaker. When no message is present, pure recency is used.
// "Return everything" stops scaling within weeks of real use — the cap is
// the contract, not an implementation detail.
//
// Phase 1.2 — context window observation: when the host passes currentContext
// (the agent's visible window), facts already present there are suppressed so
// iranti never re-injects what the agent can already see. The response reports
// how many were suppressed via `alreadyPresent`. Correction of *stale* context
// (the window holds an outdated value) is Phase 3; Phase 1.2 only suppresses.

import { z } from "zod";
import type { Fact, Rule } from "../../db/schema.js";
import {
  CHECKPOINT_KEY,
  getActiveCheckpoint,
} from "../../library/checkpoints.js";
import { upsertEntity } from "../../library/entities.js";
import {
  VALID_SURFACES,
  readRelevantFactsByEntity,
  writeFact,
} from "../../library/facts.js";
import { getRulesForAttend } from "../../library/rules.js";
import { graph } from "../../graph/index.js";
import { extractor } from "../../extract/index.js";
import { EXTRACT_SOURCE, extractArtifacts } from "../extractor.js";
import { ensureContext } from "../context.js";
import { writeAttendLog, persistMetricCounters } from "../../library/attend-log.js";
import { comprehensionMetrics } from "../../library/conflicts.js";

export const MAX_FACTS_PER_ENTITY = 10;
export const MAX_TOTAL_FACTS = 20;

// Track the last persisted metric values so we only send deltas.
// Reset to zero on process start; DB holds the cumulative all-time total.
let lastSyncedMetrics = {
  minimalConflictsChecked: 0,
  supersessions: 0,
  escalations: 0,
  deepConflictsDetected: 0,
};

// ---------------------------------------------------------------------------
// Async edge recording — best-effort, never blocks the response
// ---------------------------------------------------------------------------

// Record co_access and governs edges after each attend that returns facts.
// Runs fire-and-forget after the response is assembled so attend latency is
// unchanged. A failure here must never surface to the caller.
//
// co_access: all-pairs among returned facts. With a cap of 20 facts that is
//            at most 190 upserts — trivial, and done concurrently.
// governs:   directed rule→fact edges for every (rule, fact) pair injected
//            together. Groundwork for graph-proximity rule triggering (Phase 3).
async function recordAttendEdges(
  returnedFacts: Fact[],
  returnedRules: Rule[],
  tenantId = "default",
): Promise<void> {
  const ops: Promise<void>[] = [];

  // All-pairs co_access among returned facts.
  for (let i = 0; i < returnedFacts.length; i++) {
    for (let j = i + 1; j < returnedFacts.length; j++) {
      ops.push(
        graph.reinforceEdge(
          { type: "fact", id: returnedFacts[i]!.id },
          { type: "fact", id: returnedFacts[j]!.id },
          "co_access",
          1,
          tenantId,
        ),
      );
    }
  }

  // governs edges: each active rule → each returned fact it co-fired with.
  for (const rule of returnedRules) {
    for (const fact of returnedFacts) {
      ops.push(
        graph.reinforceEdge(
          { type: "rule", id: rule.id },
          { type: "fact", id: fact.id },
          "governs",
          1,
          tenantId,
        ),
      );
    }
  }

  await Promise.all(ops);
}

// ---------------------------------------------------------------------------
// Async semantic extraction — Phase 2b
// ---------------------------------------------------------------------------

// Extract decision/preference facts from the message and write them to the
// primary entity. Runs entirely off the response path; extracted facts
// surface on the *next* attend call.
async function extractAndStore(
  message: string,
  primary: { entityType: string; entityId: string },
  sessionId: string,
  agentId: string,
): Promise<void> {
  const extracted = await extractor.extract(message);
  if (extracted.length === 0) return;

  await upsertEntity(primary.entityType, primary.entityId);
  for (const fact of extracted) {
    await writeFact({
      entityType: primary.entityType,
      entityId: primary.entityId,
      key: fact.key,
      value: fact.value,
      source: fact.source,
      sessionId,
      agentId,
    });
  }
}

const entityHintSchema = z.object({
  entityType: z
    .string()
    .min(1)
    .describe("Broad category: 'user', 'project', 'system', ..."),
  entityId: z.string().min(1).describe("Identifier within the type."),
});

export const attendInputSchema = {
  entityHints: z
    .array(entityHintSchema)
    .default([])
    .describe(
      "Entities in scope for this conversation turn. The first hint is the " +
        "primary entity — extracted artifacts are stored on it.",
    ),
  message: z
    .string()
    .optional()
    .describe(
      "The latest user message, verbatim. iranti extracts and stores URLs " +
        "and file paths from it automatically.",
    ),
  currentContext: z
    .string()
    .optional()
    .describe(
      "The agent's currently visible context window, or a representative " +
        "slice of it. iranti suppresses any fact whose value is already " +
        "present here, so it never re-injects what the agent can already " +
        "see. Omit to receive all relevant facts.",
    ),
  surface: z
    .enum(VALID_SURFACES)
    .optional()
    .describe("Which AI host platform this call comes from."),
  agentName: z
    .string()
    .optional()
    .describe(
      "Agent name for the handshake. Only the first tool call's name is " +
        "used; subsequent values are ignored.",
    ),
};

export const attendInput = z.object(attendInputSchema);
export type AttendInput = z.infer<typeof attendInput>;

export interface AttendResult {
  rules: Array<{ entity: string; text: string; priority: number }>;
  facts: Array<{
    entity: string;
    key: string;
    value: string;
    source: string;
    updatedAt: string;
  }>;
  checkpoint: { entity: string; text: string; updatedAt: string } | null;
  extracted: Array<{ kind: string; value: string }>;
  // Phase 1.2: how many relevant facts were suppressed because their value
  // was already present in the host-provided currentContext. 0 when no
  // currentContext was passed.
  alreadyPresent: number;
}

function entityLabel(f: { entityType: string; entityId: string }): string {
  return `${f.entityType}/${f.entityId}`;
}

// Collapse whitespace and lowercase so presence checks are robust to
// formatting differences between the stored fact and the agent's window.
function normalizeForContext(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// True if a fact value is already present in the (already-normalized) window.
// Values shorter than the floor are never suppressed — short strings produce
// false-positive substring hits, and a missed suppression is far cheaper than
// hiding a real fact. Long values are probed by a leading slice so a verbatim
// copy in the window still matches without requiring the whole value.
const PRESENCE_MIN_LEN = 8;
const PRESENCE_PROBE_LEN = 160;
function isAlreadyPresent(value: string, normalizedHaystack: string): boolean {
  const needle = normalizeForContext(value);
  if (needle.length < PRESENCE_MIN_LEN) return false;
  const probe =
    needle.length > PRESENCE_PROBE_LEN ? needle.slice(0, PRESENCE_PROBE_LEN) : needle;
  return normalizedHaystack.includes(probe);
}

// The full attend pipeline, separated from MCP plumbing so integration
// tests can call it directly against the database.
export async function attend(input: AttendInput): Promise<AttendResult> {
  const startTime = Date.now();
  const ctx = await ensureContext(input.agentName);
  const hints = input.entityHints;

  // ---- WRITE side: extract artifacts from the message ----------------------
  // Extracted facts land on the primary entity (first hint). With no hints,
  // they land on the session entity so they are at least recoverable.
  const primary = hints[0] ?? {
    entityType: "session",
    entityId: ctx.session.id,
  };

  const artifacts = input.message ? extractArtifacts(input.message) : [];

  if (artifacts.length > 0) {
    await upsertEntity(primary.entityType, primary.entityId);
    for (const artifact of artifacts) {
      await writeFact({
        entityType: primary.entityType,
        entityId: primary.entityId,
        key: artifact.key,
        value: artifact.value,
        source: EXTRACT_SOURCE,
        surface: input.surface,
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
      });
    }
  }

  // ---- READ side: rules + recent facts + checkpoint ------------------------
  const rules = await getRulesForAttend(hints);

  const factsPerEntity = await Promise.all(
    hints.map((h) =>
      readRelevantFactsByEntity(
        h.entityType,
        h.entityId,
        MAX_FACTS_PER_ENTITY,
        input.message,
      ),
    ),
  );
  const ranked = factsPerEntity
    .flat()
    // The checkpoint is returned separately — don't duplicate it here.
    .filter((f: Fact) => f.key !== CHECKPOINT_KEY)
    // When a message is present, each entity's facts are already
    // relevance-ranked by readRelevantFactsByEntity — do not re-sort by
    // recency or the ranking is undone. Without a message, sort by recency.
    .sort((a, b) =>
      input.message ? 0 : b.updatedAt.getTime() - a.updatedAt.getTime(),
    );

  // Phase 1.2 — context window observation. Suppress facts already present in
  // the host-reported window BEFORE applying the total cap, so the injected
  // budget is filled with facts the agent does not already hold. Suppression
  // counts toward `alreadyPresent` for token-saving measurement.
  let alreadyPresent = 0;
  let suppressedChars = 0;
  const visible = input.currentContext
    ? (() => {
        const haystack = normalizeForContext(input.currentContext);
        return ranked.filter((f: Fact) => {
          if (isAlreadyPresent(f.value, haystack)) {
            alreadyPresent++;
            suppressedChars += f.value.length;
            return false;
          }
          return true;
        });
      })()
    : ranked;

  const returnedFacts = visible.slice(0, MAX_TOTAL_FACTS);

  const checkpoint = await getActiveCheckpoint(hints);

  // Phase 2a — async edge recording. Fire-and-forget after the response is
  // assembled so this never adds latency. Errors are logged, never thrown.
  if (returnedFacts.length >= 2 || rules.length > 0) {
    void recordAttendEdges(returnedFacts, rules).catch((err: unknown) =>
      console.error("[iranti] edge recording error:", err),
    );
  }

  // Phase 2b — async semantic extraction. Extracts decision/preference facts
  // from the message and writes them fire-and-forget. They surface on the
  // *next* attend. Never blocks the response.
  if (input.message) {
    void extractAndStore(input.message, primary, ctx.session.id, ctx.agent.id).catch(
      (err: unknown) => console.error("[iranti] extraction error:", err),
    );
  }

  // Phase 2.5 (CORE-14) — attend_log + metric counters. Both fire-and-forget
  // after the response is assembled so they never add latency.
  const latencyMs = Date.now() - startTime;
  const injectedChars =
    returnedFacts.reduce((s, f) => s + f.value.length, 0) +
    rules.reduce((s, r) => s + r.text.length, 0);

  void writeAttendLog({
    sessionId: ctx.session.id,
    agentId: ctx.agent.id,
    surface: input.surface,
    factCount: returnedFacts.length,
    ruleCount: rules.length,
    alreadyPresent,
    injectedChars,
    injectedTokensEst: Math.floor(injectedChars / 4),
    suppressedTokensEst: Math.floor(suppressedChars / 4),
    latencyMs,
  }).catch((err: unknown) => console.error("[iranti] attend log error:", err));

  // Compute deltas since last sync and persist them, then advance the cursor.
  const delta = {
    minimalConflictsChecked:
      comprehensionMetrics.minimalConflictsChecked - lastSyncedMetrics.minimalConflictsChecked,
    supersessions: comprehensionMetrics.supersessions - lastSyncedMetrics.supersessions,
    escalations: comprehensionMetrics.escalations - lastSyncedMetrics.escalations,
    deepConflictsDetected:
      comprehensionMetrics.deepConflictsDetected - lastSyncedMetrics.deepConflictsDetected,
  };
  lastSyncedMetrics = { ...comprehensionMetrics };
  void persistMetricCounters(delta).catch(
    (err: unknown) => console.error("[iranti] metric persist error:", err),
  );

  return {
    rules: rules.map((r) => ({
      entity: entityLabel(r),
      text: r.text,
      priority: r.priority,
    })),
    facts: returnedFacts.map((f) => ({
      entity: entityLabel(f),
      key: f.key,
      value: f.value,
      source: f.source,
      updatedAt: f.updatedAt.toISOString(),
    })),
    checkpoint: checkpoint
      ? {
          entity: entityLabel(checkpoint),
          text: checkpoint.value,
          updatedAt: checkpoint.updatedAt.toISOString(),
        }
      : null,
    extracted: artifacts.map((a) => ({ kind: a.kind, value: a.value })),
    alreadyPresent,
  };
}
