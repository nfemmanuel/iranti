// iranti_history — Phase 1.1
//
// Returns the full change history for a fact: every value it has ever held,
// newest first. Useful for auditing how a decision or preference evolved.
//
// Accepts either a factId directly, or entityType + entityId + key.

import { z } from "zod";
import {
  findFact,
  getFactById,
  getFactHistory,
  getFactHistoryByKey,
} from "../../library/facts.js";
import { ensureContext } from "../context.js";

export const historyInputSchema = {
  factId: z.string().uuid().optional().describe("The fact UUID, if known."),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Together with entityType + entityId, identifies the fact when UUID is unknown.",
    ),
  agentName: z.string().optional(),
};

export const historyInput = z.object(historyInputSchema);
export type HistoryInput = z.infer<typeof historyInput>;

export interface HistoryResult {
  found: boolean;
  current: {
    entity: string;
    key: string;
    value: string;
    updatedAt: string;
  } | null;
  history: Array<{ value: string; reason: string; archivedAt: string }>;
  reason?: string;
}

export async function history(input: HistoryInput): Promise<HistoryResult> {
  await ensureContext(input.agentName);

  if (input.factId) {
    const [fact, rows] = await Promise.all([
      getFactById(input.factId),
      getFactHistory(input.factId),
    ]);
    return {
      found: fact !== undefined || rows.length > 0,
      current: fact
        ? {
            entity: `${fact.entityType}/${fact.entityId}`,
            key: fact.key,
            value: fact.value,
            updatedAt: fact.updatedAt.toISOString(),
          }
        : null,
      history: rows.map((h) => ({
        value: h.value,
        reason: h.archivedReason,
        archivedAt: h.archivedAt.toISOString(),
      })),
    };
  }

  if (!input.entityType || !input.entityId || !input.key) {
    return {
      found: false,
      current: null,
      history: [],
      reason: "Provide either factId, or all of entityType + entityId + key.",
    };
  }

  const [fact, rows] = await Promise.all([
    findFact(input.entityType, input.entityId, input.key),
    getFactHistoryByKey(input.entityType, input.entityId, input.key),
  ]);

  return {
    found: fact !== undefined || rows.length > 0,
    current: fact
      ? {
          entity: `${fact.entityType}/${fact.entityId}`,
          key: fact.key,
          value: fact.value,
          updatedAt: fact.updatedAt.toISOString(),
        }
      : null,
    history: rows.map((h) => ({
      value: h.value,
      reason: h.archivedReason,
      archivedAt: h.archivedAt.toISOString(),
    })),
  };
}
