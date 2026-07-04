// Write-side embed hook — CORE-16.
//
// Fired fire-and-forget (trackBackground'd — RULE-2) from writeFact's
// post-commit side effects, mirroring recordWriteEdges/checkConflict's
// pattern in src/library/facts.ts. Embeds `key + ": " + value`, writes the
// vector to facts.embedding (via the one vector-column accessor) and the
// regime signature to facts.metadata.embedRegime. No-op when the embedder
// is off — the common/default path costs nothing beyond the isEmbedderActive
// check itself.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facts } from "../db/schema.js";
import { getEmbedder, isEmbedderActive } from "./index.js";
import { buildEmbedRegime, composeEmbedText } from "./regime.js";
import { setEmbeddingColumn } from "./vector-column.js";

export async function embedFactOnWrite(factId: string, key: string, value: string): Promise<void> {
  if (!isEmbedderActive()) return;

  const embedder = getEmbedder();
  const text = composeEmbedText(key, value);
  const [vec] = await embedder.embed([text]);
  if (!vec || vec.length === 0) return; // embedder degraded — leave the fact un-embedded, lazy retry on next write

  await setEmbeddingColumn(factId, vec);

  // Merge embedRegime into metadata without clobbering any other metadata
  // key a caller may have set (rawKey, transient) — same merge discipline as
  // withRawKey/withTransient in src/library/keys.ts, but applied post-commit
  // here (a second UPDATE) rather than folded into the original insert,
  // because the vector itself isn't known until after the embed() call
  // returns — which happens after the transaction that wrote the fact has
  // already committed (writeFact's fire-and-forget post-commit pattern).
  const current = await db.query.facts.findFirst({
    where: eq(facts.id, factId),
    columns: { metadata: true },
  });
  const base =
    current?.metadata != null && typeof current.metadata === "object"
      ? (current.metadata as Record<string, unknown>)
      : {};
  await db
    .update(facts)
    .set({ metadata: { ...base, embedRegime: buildEmbedRegime(embedder.identity) } })
    .where(eq(facts.id, factId));
}
