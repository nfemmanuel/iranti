// Integration tests — CORE-17 chunk recall layer (embedder ON via the
// test-only MockEmbedder, so CI never needs a live Ollama — deterministic
// trigram pseudo-vectors, see src/embed/mock.ts).
//
// These pin the mechanism the competitive benchmark proved (semantic recall
// over RAW chunks) INSIDE iranti's own store: store episodes verbatim +
// embedded, then retrieve the meaning-closest one for a query that shares NO
// keywords with it — the exact case lexical recall (12–18% on the benchmark)
// structurally can't reach. Below-floor returns nothing: that empty result is
// the abstention signal (G1/never-invent at retrieval time).
//
// Module-load-order care mirrors src/tests/semantic-retrieval.test.ts:
// connection.ts reads IRANTI_DB_ENGINE/IRANTI_DATA_DIR at import time and
// index.ts reads IRANTI_EMBEDDER per call, so env is set before any dynamic
// import of iranti internals. Each test uses a unique project scope so chunks
// never leak across cases in the shared DB.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-chunks-"));

beforeAll(() => {
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  process.env["IRANTI_EMBEDDER"] = "mock";
  delete process.env["DATABASE_URL"];
});

afterAll(async () => {
  delete process.env["IRANTI_EMBEDDER"];
  const { pool } = await import("../db/connection.js");
  await pool.end({ timeout: 5 }).catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

// A paraphrase pair with GENUINELY zero keyword overlap but enough trigram
// overlap for the MockEmbedder to score above the 0.60 floor — the same
// fixture verified by CORE-16's semantic-retrieval.test.ts.
const RELATED_CHUNK =
  "user: the team refers to it as the sync wiki page for engineering coordination";
const PARAPHRASE_QUERY =
  "what is the nickname folks use for the shared collaboration record location";

// A different-topic episode: should rank below RELATED_CHUNK for the query
// (and, for a gibberish query, everything lands below the floor).
const OTHER_CHUNK =
  "user: the deployment pipeline runs nightly builds against the staging cluster";

async function seed(
  project: string,
  contents: string[],
): Promise<void> {
  const { writeChunk, embedChunkOnWrite } = await import("../library/chunks.js");
  for (const content of contents) {
    const { id } = await writeChunk({ content }, "default", project);
    // Awaited (not fire-and-forget) so retrieval is deterministic — the live
    // write path trackBackgrounds this instead.
    await embedChunkOnWrite(id, content);
  }
}

describe("CORE-17 — chunk recall (MockEmbedder)", () => {
  it("retrieves the meaning-closest chunk for a query with zero keyword overlap", async () => {
    const { searchChunksSemantic } = await import("../library/chunks.js");
    const project = `/fake/proj/${randomUUID()}`;

    await seed(project, [RELATED_CHUNK, OTHER_CHUNK]);

    const hits = await searchChunksSemantic(PARAPHRASE_QUERY, 5, "default", project);

    expect(hits.length).toBeGreaterThan(0);
    // The semantically-closest episode ranks first, despite sharing no query
    // keywords — the whole point of the recall layer.
    expect(hits[0]!.content).toBe(RELATED_CHUNK);
    expect(hits[0]!.score).toBeGreaterThan(0.6);
  });

  it("returns nothing for an unrelated query — the abstention signal (below-floor honesty)", async () => {
    const { searchChunksSemantic } = await import("../library/chunks.js");
    const project = `/fake/proj/${randomUUID()}`;

    await seed(project, [RELATED_CHUNK]);

    // Gibberish shares no trigrams with the stored episode → lands well below
    // the 0.60 floor → empty result. An empty result is how the caller knows
    // to abstain rather than answer from an irrelevant chunk.
    const hits = await searchChunksSemantic(
      "xkqz vprmtlon quasar fluctuation zzytron bwg... plough",
      5,
      "default",
      project,
    );

    expect(hits).toHaveLength(0);
  });

  it("returns nothing when the embedder is off (zero-infra default preserved)", async () => {
    const { searchChunksSemantic } = await import("../library/chunks.js");
    const project = `/fake/proj/${randomUUID()}`;

    await seed(project, [RELATED_CHUNK]); // embedded under mock

    process.env["IRANTI_EMBEDDER"] = "off";
    try {
      const hits = await searchChunksSemantic(PARAPHRASE_QUERY, 5, "default", project);
      // isEmbedderActive() short-circuits before any fetch — no recall without
      // an embedder, exactly today's deterministic-only behavior.
      expect(hits).toHaveLength(0);
    } finally {
      process.env["IRANTI_EMBEDDER"] = "mock"; // restore for later tests
    }
  });

  it("holds cross-project isolation — a chunk in project A never surfaces for project B", async () => {
    const { searchChunksSemantic } = await import("../library/chunks.js");
    const projectA = `/fake/proj/${randomUUID()}`;
    const projectB = `/fake/proj/${randomUUID()}`;

    await seed(projectA, [RELATED_CHUNK]);

    const hits = await searchChunksSemantic(PARAPHRASE_QUERY, 10, "default", projectB);

    expect(hits).toHaveLength(0);
  });
});
