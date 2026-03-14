import { Router, Request, Response } from "express";
import { getDb } from "../../library/client";

export const batchRouter = Router();

/**
 * Batch query endpoint: fetch multiple KB entries in one request
 */
batchRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { items } = req.body as { items?: { entity: string; key: string }[] };

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }

    if (items.length > 200) {
      return res.status(400).json({ error: "too many items (max 200)" });
    }

    const db = getDb();

    // Parse entity strings and query in parallel
    const results = await Promise.all(
      items.map(async (it) => {
        const [entityType, ...rest] = it.entity.split("/");
        const entityId = rest.join("/");

        if (!entityType || !entityId || !it.key) {
          return { entity: it.entity, key: it.key, hit: false };
        }

        try {
          const row = await db.knowledgeEntry.findUnique({
            where: {
              entityType_entityId_key: {
                entityType,
                entityId,
                key: it.key,
              },
            },
          });

          if (!row) {
            return { entity: it.entity, key: it.key, hit: false };
          }
          if (row.isProtected) {
            return { entity: it.entity, key: it.key, hit: false };
          }

          return {
            entity: it.entity,
            key: it.key,
            hit: true,
            value: row.valueRaw,
            summary: row.valueSummary,
            confidence: row.confidence,
            source: row.source,
          };
        } catch {
          return { entity: it.entity, key: it.key, hit: false };
        }
      })
    );

    return res.json({ results });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "batchQuery failed" });
  }
});
