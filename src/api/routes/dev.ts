import { Router, Request, Response } from "express";
import { getDb } from "../../library/client";

export const devRouter = Router();

/**
 * DEV ONLY: clears benchmark data so runs are comparable.
 * Deletes only entities written by the benchmark agent.
 */
devRouter.post("/reset", async (req: Request, res: Response) => {
  try {
    // SAFETY: only allow in non-production
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Dev reset disabled in production." });
    }

    const db = getDb();
    
    const result = await db.knowledgeEntry.deleteMany({
      where: {
        createdBy: "benchmark",
      },
    });

    return res.json({ ok: true, deleted: result.count });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "reset failed" });
  }
});
