// Integration test - CORE-17 S1 (write path): `iranti_attend` stores the raw
// turn as a chunk and embeds it fire-and-forget, mirroring how writeFact fires
// embedFactOnWrite (src/library/facts.ts:508 -> src/embed/write-hook.ts).
//
// This is the precondition for the whole retrieval-first recall tier: you
// cannot retrieve a chunk you never wrote. src/tests/chunks.test.ts already
// pins the recall MECHANISM in isolation (writeChunk + embedChunkOnWrite +
// searchChunksSemantic); THIS test pins that the PRODUCT write path (attend)
// actually fills the pool, gated + scoped per the S1 spec.
//
// Harness mirrors src/tests/chunks.test.ts + src/tests/semantic-retrieval.ts:
// temp PGlite, IRANTI_EMBEDDER="mock" (deterministic, no live Ollama), and
// IRANTI_EXTRACT_SYNC="1" so attend() BLOCKS on its background post-attend
// chain (which now carries the chunk write+embed) - a caller can ingest then
// read the chunk row in the same process without racing the detached chain.
//
// Module-load-order care (same as the two files above): connection.ts reads
// IRANTI_DB_ENGINE / IRANTI_DATA_DIR at import time and embed/index.ts reads
// IRANTI_EMBEDDER per call, so env is set before any dynamic import() of
// iranti internals. attend() resolves its project ONCE per process from
// process.cwd() via ensureContext(), and ensureContext memoizes ONE session
// for the whole process - so every attend call in this file shares one session
// id. We therefore read each written chunk back by its (unique-per-case)
// CONTENT rather than by session id, which both disambiguates the two calls AND
// proves the exact turn text was stored verbatim. We still assert the chunk's
// project === the ensureContext-resolved project (to prove "for that project")
// and its sessionId === that memoized session (the FK S1 threads through
// WriteChunkInput.sessionId).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-chunks-attend-"));

beforeAll(() => {
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  process.env["IRANTI_EMBEDDER"] = "mock";
  process.env["IRANTI_EXTRACT_SYNC"] = "1";
  delete process.env["DATABASE_URL"];
});

afterAll(async () => {
  delete process.env["IRANTI_EMBEDDER"];
  delete process.env["IRANTI_EXTRACT_SYNC"];
  const { pool } = await import("../db/connection.js");
  await pool.end({ timeout: 5 }).catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

// Read the one chunk written with a given verbatim content, with its embedding
// rendered as text (the ::text cast is how src/embed/vector-column.ts + the
// chunk read path in chunks.ts:101 uniformly surface the vector on both
// engines) and its metadata + provenance, so the assertions can check
// embedding presence, metadata.embedRegime, project scope, and session FK
// directly. Content is unique per test case, so this unambiguously selects the
// row that a specific attend call wrote (unlike the process-shared session id).
async function readChunkByContent(content: string): Promise<{
  project: string;
  sessionId: string | null;
  embedding: number[] | null;
  embedRegime: unknown;
} | null> {
  const { db } = await import("../db/connection.js");
  const { chunks } = await import("../db/schema.js");
  const { parseStoredVector } = await import("../embed/vector-column.js");
  const { eq, sql } = await import("drizzle-orm");

  const rows = await db
    .select({
      project: chunks.project,
      sessionId: chunks.sessionId,
      embedding: sql<string | null>`${chunks.embedding}::text`,
      metadata: chunks.metadata,
    })
    .from(chunks)
    .where(eq(chunks.content, content));

  expect(rows.length).toBeLessThanOrEqual(1); // one turn -> one chunk row
  const row = rows[0];
  if (!row) return null;
  const meta =
    row.metadata != null && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    project: row.project,
    sessionId: row.sessionId,
    embedding: parseStoredVector(row.embedding),
    embedRegime: meta["embedRegime"],
  };
}

describe("CORE-17 S1 - attend write path stores + embeds a chunk", () => {
  it("embedder ON: an attend ingest writes a chunk in that project with a non-null embedding and metadata.embedRegime", async () => {
    const { attend } = await import("../mcp/tools/attend.js");
    const { ensureContext } = await import("../mcp/context.js");

    // The context (agent/session/project) attend will use this process - the
    // project id lets us prove the chunk landed in the attributing project, and
    // the session id lets us assert the S1 provenance FK.
    const ctx = await ensureContext();

    const message =
      "user: we moved the sync wiki page to a new home for engineering coordination";
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s1" }],
      message,
      phase: "post-response",
    });
    // S1 is write-side; the read-side chunks[] field is S2's concern (pinned by
    // src/tests/chunks-attend-read.test.ts). S2 has since landed, so chunks[] is
    // now a legitimate ADDITIVE, omitted-when-empty field: this write-turn's own
    // just-written chunk is embedded in the post-attend chain AFTER the read
    // side computes results, so it isn't in the pool at this read's time. We
    // therefore only assert the S2 contract holds if the field appears at all
    // (it is a well-formed array of {content, score}) rather than forbidding it.
    if ("chunks" in result && result.chunks) {
      expect(Array.isArray(result.chunks)).toBe(true);
      for (const c of result.chunks) {
        expect(typeof c.content).toBe("string");
        expect(typeof c.score).toBe("number");
      }
    }

    const chunk = await readChunkByContent(message);
    expect(chunk).not.toBeNull();
    // Scoped to the attributing project (currentProject = ctx.project.id),
    // never a combined/effective partner (§11.6).
    expect(chunk!.project).toBe(ctx.project.id);
    // Provenance threaded through (S1 passes ctx.session.id into WriteChunkInput).
    expect(chunk!.sessionId).toBe(ctx.session.id);
    // Embedded fire-and-forget through the post-attend chain (awaited here
    // because IRANTI_EXTRACT_SYNC=1): the vector is present...
    expect(chunk!.embedding).not.toBeNull();
    expect(chunk!.embedding!.length).toBeGreaterThan(0);
    // ...and the regime signature was written to metadata (the CORE-16 D4
    // version-lock embedChunkOnWrite persists alongside the vector).
    expect(chunk!.embedRegime).toBeDefined();
    expect(chunk!.embedRegime).not.toBeNull();
  });

  it("embedder OFF: the same attend ingest writes the chunk row but leaves it UN-embedded (no vector, no embedRegime) - zero-infra default preserved", async () => {
    // Flip the embedder off for THIS call only. attend()/embedChunkOnWrite read
    // IRANTI_EMBEDDER per call (isEmbedderActive() re-derives), while the
    // project/session context is memoized per process - so this exercises the
    // real guard placement: writeChunk still runs (one insert), embedChunkOnWrite
    // no-ops, exactly mirroring writeFact->embedFactOnWrite when the embedder is
    // off. This pins the "writes the row but does not embed" branch (the S1
    // acceptance explicitly permits pinning whichever the guard implements).
    process.env["IRANTI_EMBEDDER"] = "off";
    try {
      const { attend } = await import("../mcp/tools/attend.js");

      const message =
        "user: the deployment pipeline now runs nightly builds against staging";
      await attend({
        entityHints: [{ entityType: "project", entityId: "core17-s1-off" }],
        message,
        phase: "post-response",
      });

      const chunk = await readChunkByContent(message);
      // The row IS written (the write path is not gated on the embedder - only
      // the embed is), so the recall pool fills the instant an embedder turns
      // on; but with the embedder off it carries no vector and no regime.
      expect(chunk).not.toBeNull();
      expect(chunk!.embedding).toBeNull();
      expect(chunk!.embedRegime).toBeUndefined();
    } finally {
      process.env["IRANTI_EMBEDDER"] = "mock"; // restore for any later cases
    }
  });

  it("mid-turn phase writes NO chunk - a read-only top-up never seeds the recall pool", async () => {
    // Mid-turn is a discovery top-up, not a real write turn; the S1 gate is
    // !isMidTurn && input.message (the same gate artifact extraction uses,
    // attend.ts:484) so a mid-turn query can never seed a chunk. Unique content
    // keeps this independent of the rows written above.
    const { attend } = await import("../mcp/tools/attend.js");

    const marker = "MID-TURN-MARKER unique probe text that must never be chunked";
    await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s1-midturn" }],
      message: marker,
      phase: "mid-turn",
    });

    const chunk = await readChunkByContent(marker);
    expect(chunk).toBeNull();
  });
});
