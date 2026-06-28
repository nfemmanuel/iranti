// Extraction cache — AX-2.
//
// A durable content-hash cache in front of the LLM extractor. Cache key =
// (input_hash, regime_signature, tenant_id). On hit: return cached
// ExtractedFact[] verbatim, zero LLM calls. On miss: fall through to normal
// extraction, then write the result fire-and-forget.
//
// Guarantees:
//  - Repeat-determinism: the same input under the same regime always returns
//    byte-identical facts after the first extraction.
//  - Never makes extraction worse: read/write errors degrade to plain extract.
//  - Cache is busted by any change to the model, prompt, extractor mode, or
//    normalizer (all four are part of the regime signature).
//
// Does NOT apply to the HeuristicExtractor — it is already pure/deterministic.

import { createHash } from "node:crypto";
import { db } from "../db/connection.js";
import { extractionCache } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import type { ExtractedFact } from "../extract/index.js";

// Trim and normalize line endings so minor whitespace differences in the same
// logical message don't produce different hashes. This is minimal/lossless:
// we don't strip content, only canonicalize invisible characters.
function normalizeForCache(rawText: string): string {
  return rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function hashInput(rawText: string): string {
  return createHash("sha256").update(normalizeForCache(rawText), "utf8").digest("hex");
}

export function buildRegimeSignature(
  extractorMode: string,
  modelId: string,
  promptVersion: string,
  normalizerVersion: string,
): string {
  return `${extractorMode}|${modelId}|${promptVersion}|${normalizerVersion}`;
}

export async function readCache(
  inputHash: string,
  regimeSignature: string,
  tenantId = "default",
): Promise<ExtractedFact[] | null> {
  const rows = await db
    .select({ result: extractionCache.result })
    .from(extractionCache)
    .where(
      and(
        eq(extractionCache.tenantId, tenantId),
        eq(extractionCache.inputHash, inputHash),
        eq(extractionCache.regimeSignature, regimeSignature),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  // Best-effort hit_count increment — fire-and-forget, never blocking.
  void db
    .update(extractionCache)
    .set({
      hitCount: sql`${extractionCache.hitCount} + 1`,
      lastHitAt: new Date(),
    })
    .where(
      and(
        eq(extractionCache.tenantId, tenantId),
        eq(extractionCache.inputHash, inputHash),
        eq(extractionCache.regimeSignature, regimeSignature),
      ),
    )
    .catch((err: unknown) =>
      console.error("[iranti] extraction-cache hit_count update error:", err),
    );

  return rows[0]!.result as ExtractedFact[];
}

export async function writeCache(
  inputHash: string,
  regimeSignature: string,
  extractorMode: string,
  modelId: string,
  promptVersion: string,
  normalizerVersion: string,
  result: ExtractedFact[],
  tenantId = "default",
): Promise<void> {
  await db
    .insert(extractionCache)
    .values({
      tenantId,
      inputHash,
      regimeSignature,
      result,
      extractorMode,
      modelId,
      promptVersion,
      normalizerVersion,
    })
    .onConflictDoNothing();
}
