// Integration test — CORE-17 S2 (read path + query router): `iranti_attend`
// classifies each read deterministically (no LLM) and, for an OPEN query,
// surfaces meaning-closest chunks in the NEW additive `AttendResult.chunks[]`
// while leaving the STRUCTURED / exact-first path and the embedder-off path
// byte-identical.
//
// This is the read-side counterpart to src/tests/chunks-attend-write.test.ts
// (S1, the write path). S1 proved attend FILLS the chunk pool; S2 proves attend
// RETRIEVES from it for open, natural-language recall and routes correctly:
//   - OPEN  (a paraphrase query, no deterministic key/alias/correction fires)
//            -> searchChunksSemantic runs -> chunks[0] is the meaning-closest
//               episode with score > the 0.60 floor, even with zero keyword
//               overlap (the exact case lexical recall — 12-18% on the bench —
//               structurally cannot reach).
//   - STRUCTURED (a deterministic keyword/exact fact hit) -> chunks are NOT
//               attached (the router keeps the exact-first path supreme and
//               additive-only; D-ROUTE / PRD re-ratified §8).
//   - embedder OFF -> no chunks[] ever (zero-infra default preserved).
//
// Harness mirrors src/tests/chunks-attend-write.test.ts: temp PGlite,
// IRANTI_EMBEDDER="mock" (deterministic trigram pseudo-vectors, no live
// Ollama), IRANTI_EXTRACT_SYNC="1" so attend() BLOCKS on its post-attend chain
// (which carries the S1 chunk write+embed) — a caller can therefore SEED a
// chunk with one attend and then RETRIEVE it with the next in the same process
// without racing the detached chain.
//
// Module-load-order care (same as chunks.test.ts / chunks-attend-write.test.ts):
// connection.ts reads IRANTI_DB_ENGINE / IRANTI_DATA_DIR at import time and
// embed/index.ts reads IRANTI_EMBEDDER per call, so env is set before any
// dynamic import() of iranti internals. ensureContext memoizes ONE project +
// session per process (from cwd) — attend scopes both the chunk WRITE
// (currentProject) and the chunk READ (effectiveProjectIds, which starts as
// [currentProject]) to that same project, so a chunk seeded here is in-scope
// for a later attend read in the same process. We use unique, zero-keyword-
// overlap fixtures per assertion so retrieval is unambiguous.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-chunks-attend-read-"));

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

// A paraphrase pair with GENUINELY zero keyword overlap but enough trigram
// overlap for the MockEmbedder to score above the 0.60 floor — the same
// fixture verified by chunks.test.ts (the isolated recall-mechanism test) and
// CORE-16's semantic-retrieval.test.ts. The recall layer's whole point is
// finding RELATED_CHUNK from PARAPHRASE_QUERY despite them sharing no words.
const RELATED_CHUNK =
  "user: the team refers to it as the sync wiki page for engineering coordination";
const PARAPHRASE_QUERY =
  "what is the nickname folks use for the shared collaboration record location";

// A different-topic episode: ranks below RELATED_CHUNK for the paraphrase.
const OTHER_CHUNK =
  "user: the deployment pipeline runs nightly builds against the staging cluster";

// Seed a chunk into the process-project's recall pool THROUGH the product write
// path (attend, phase post-response, S1) so the read side under test retrieves
// exactly what a real ingest would have stored. IRANTI_EXTRACT_SYNC=1 makes
// attend await its post-attend chain, so on return the chunk is written AND
// embedded (mock) and immediately retrievable by a later attend in this process.
async function seedChunkViaAttend(message: string): Promise<void> {
  const { attend } = await import("../mcp/tools/attend.js");
  await attend({
    entityHints: [{ entityType: "project", entityId: "core17-s2-seed" }],
    message,
    phase: "post-response",
  });
}

describe("CORE-17 S2 — attend read path + query router (MockEmbedder)", () => {
  it("OPEN paraphrase query surfaces the meaning-closest chunk in AttendResult.chunks[] (> floor, zero keyword overlap)", async () => {
    const { attend } = await import("../mcp/tools/attend.js");

    // Fill the recall pool with two zero-overlap episodes via the real write
    // path. Both settle (write + mock-embed) before the reads below.
    await seedChunkViaAttend(RELATED_CHUNK);
    await seedChunkViaAttend(OTHER_CHUNK);

    // An OPEN query: a natural-language paraphrase sharing NO keywords with any
    // stored fact, so no deterministic (keyword/alias/correction) hit fires ->
    // the router classifies OPEN -> searchChunksSemantic runs over the pool.
    // We pass mid-turn to KEEP THIS A PURE READ (mid-turn never seeds a chunk,
    // S1 gate) so the query text itself doesn't pollute the pool for later
    // assertions in this file.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s2-read" }],
      message: PARAPHRASE_QUERY,
      phase: "mid-turn",
    });

    // The NEW additive field exists and carries the semantic hits.
    expect(result.chunks).toBeDefined();
    expect(result.chunks!.length).toBeGreaterThan(0);
    // The semantically-closest episode ranks first despite sharing no query
    // keywords — the retrieval-first recall the whole tier exists to deliver.
    expect(result.chunks![0]!.content).toBe(RELATED_CHUNK);
    expect(result.chunks![0]!.score).toBeGreaterThan(0.6);
  });

  it("STRUCTURED query (a deterministic keyword fact hit) does NOT attach chunks — exact-first stays supreme + additive-only (D-ROUTE)", async () => {
    const { attend } = await import("../mcp/tools/attend.js");

    // Seed a fact via a URL artifact (attend extracts URLs deterministically
    // and stores them under a `shared-url:<hash>` key). iranti's `matched` flag
    // is a KEY-token claim, not a value-substring one (facts.ts hasKeyTokenMatch
    // + the measured PRD-0f rationale: a fact's key is its NAME; brushing its
    // prose is too weak to claim a match). So the STRUCTURED query below names
    // the key's own nouns ("shared url") — a query that references a KNOWN key,
    // the canonical STRUCTURED case the router must keep on the exact-first path.
    const url = "https://example.com/core17-structured-probe";
    await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s2-struct" }],
      message: `the design doc lives at ${url}`,
      phase: "post-response",
    });

    // A query that KEY-token-overlaps the stored artifact fact (shared, url) ->
    // matchedFactIds is non-empty -> the router classifies STRUCTURED -> the
    // chunk read is skipped entirely (chunks omitted). Even though the pool now
    // also contains related chunks from earlier cases, the exact-first path is
    // never augmented for a structured query.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s2-struct" }],
      message: `what is the shared url we saved`,
      phase: "mid-turn",
    });

    // At least one fact matched (the STRUCTURED precondition actually held).
    expect(result.facts.some((f) => f.matched)).toBe(true);
    // STRUCTURED contract: chunks are NOT attached (omitted-when-not-run).
    expect(result.chunks).toBeUndefined();
  });

  it("embedder OFF: an OPEN query attaches NO chunks — zero-infra default byte-identical", async () => {
    // Seed a retrievable chunk UNDER the mock embedder first, then flip the
    // embedder off for the read: the router still classifies OPEN, but
    // searchChunksSemantic short-circuits on isEmbedderActive() and returns []
    // -> no chunks[] field. This is the byte-identical-when-off guarantee.
    await seedChunkViaAttend(RELATED_CHUNK);

    process.env["IRANTI_EMBEDDER"] = "off";
    try {
      const { attend } = await import("../mcp/tools/attend.js");
      const result = await attend({
        entityHints: [{ entityType: "project", entityId: "core17-s2-off" }],
        message: PARAPHRASE_QUERY,
        phase: "mid-turn",
      });
      // No embedder -> no recall -> the field is absent, exactly today's shape.
      expect(result.chunks).toBeUndefined();
    } finally {
      process.env["IRANTI_EMBEDDER"] = "mock"; // restore for any later cases
    }
  });

  it("OPEN query with an empty/irrelevant pool abstains — below-floor gibberish yields no chunks[] (S3 abstention primitive rides on this)", async () => {
    // A brand-new project scope with a gibberish query: even though the shared
    // DB holds RELATED_CHUNK from earlier cases, they belong to a DIFFERENT
    // entityHint scope AND the query shares no trigrams with anything -> every
    // candidate lands below the 0.60 floor -> searchChunksSemantic returns []
    // -> chunks omitted. The empty result IS the abstention signal (chunks.ts
    // header) — S3 lifts it to an explicit AttendResult.abstain; S2 pins the
    // read-path behavior it builds on.
    const { attend } = await import("../mcp/tools/attend.js");
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s2-abstain" }],
      message: "xkqz vprmtlon quasar fluctuation zzytron bwg plough",
      phase: "mid-turn",
    });
    expect(result.chunks).toBeUndefined();
  });

  it("byte-identical guard: for the SAME OPEN query, everything EXCEPT chunks is identical embedder-on vs embedder-off (the additive-only proof, plan §S2 criterion 4)", async () => {
    // The strongest in-harness proof that S2 is purely additive: run the exact
    // same OPEN read twice — once with the embedder ON (chunk recall active),
    // once OFF (today's deterministic-only path) — and assert the ENTIRE payload
    // minus the chunks field is deep-equal. If S2 perturbed facts[]/matched/
    // semantic/peripheral/corrections/anything on the exact-first or off path,
    // this fails. Same project scope + phase both times so the only intended
    // difference is the presence of the additive chunks field on the ON run.
    const { attend } = await import("../mcp/tools/attend.js");

    // A stable, chunk-retrievable pool so the ON run genuinely produces chunks
    // (making the "everything else is still identical" claim meaningful).
    await seedChunkViaAttend(RELATED_CHUNK);

    const args = {
      entityHints: [{ entityType: "project", entityId: "core17-s2-byteid" }],
      message: PARAPHRASE_QUERY,
      phase: "mid-turn" as const,
    };

    process.env["IRANTI_EMBEDDER"] = "mock";
    const onResult = await attend(args);

    process.env["IRANTI_EMBEDDER"] = "off";
    let offResult;
    try {
      offResult = await attend(args);
    } finally {
      process.env["IRANTI_EMBEDDER"] = "mock"; // restore
    }

    // The ON run surfaced chunks (additive tier active)...
    expect(onResult.chunks).toBeDefined();
    expect(onResult.chunks!.length).toBeGreaterThan(0);
    // ...the OFF run did not (zero-infra default)...
    expect(offResult.chunks).toBeUndefined();

    // ...and stripping the additive field leaves two byte-identical payloads.
    // nextDue is deterministic from phase; projectState is a once-per-process
    // latch that both calls see the same way (neither is the first call). No
    // other field may differ.
    const stripChunks = (r: typeof onResult) => {
      const { chunks: _omit, ...rest } = r;
      return rest;
    };
    expect(stripChunks(onResult)).toStrictEqual(stripChunks(offResult));
  });
});
