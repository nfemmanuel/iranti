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
// hint and MAX_TOTAL_FACTS overall, recency-ordered (updatedAt DESC).
// "Return everything" stops scaling within weeks of real use — the cap is
// the contract, not an implementation detail.

import { z } from "zod";
import type { Fact } from "../../db/schema.js";
import {
  CHECKPOINT_KEY,
  getActiveCheckpoint,
} from "../../library/checkpoints.js";
import { upsertEntity } from "../../library/entities.js";
import {
  VALID_SURFACES,
  readRecentFactsByEntity,
  writeFact,
} from "../../library/facts.js";
import { getRulesForAttend } from "../../library/rules.js";
import { EXTRACT_SOURCE, extractArtifacts } from "../extractor.js";
import { ensureContext } from "../context.js";

export const MAX_FACTS_PER_ENTITY = 10;
export const MAX_TOTAL_FACTS = 20;

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
}

function entityLabel(f: { entityType: string; entityId: string }): string {
  return `${f.entityType}/${f.entityId}`;
}

// The full attend pipeline, separated from MCP plumbing so integration
// tests can call it directly against the database.
export async function attend(input: AttendInput): Promise<AttendResult> {
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
      readRecentFactsByEntity(h.entityType, h.entityId, MAX_FACTS_PER_ENTITY),
    ),
  );
  const facts = factsPerEntity
    .flat()
    // The checkpoint is returned separately — don't duplicate it here.
    .filter((f: Fact) => f.key !== CHECKPOINT_KEY)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, MAX_TOTAL_FACTS);

  const checkpoint = await getActiveCheckpoint(hints);

  return {
    rules: rules.map((r) => ({
      entity: entityLabel(r),
      text: r.text,
      priority: r.priority,
    })),
    facts: facts.map((f) => ({
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
  };
}
