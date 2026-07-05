// Integration test — CORE-17 S3 (the abstention gate): `iranti_attend` lifts
// the S2 empty-chunk primitive to an explicit AttendResult.abstain when, for
// an OPEN query, the semantic tier cleared the similarity floor for NOTHING
// (chunks omitted) AND the deterministic tiers produced no matched fact. This
// is D-ABSTAIN / G1 (never-invent) made first-class at retrieval time: iranti
// saying "I have nothing that answers this" instead of a host having to infer
// it from "no matched fact AND no chunk."
//
// Relationship to Layer 0f (pinned here so the two mechanisms stay coherent):
// Layer 0f already lets a host INFER no-answer — an all-`matched:false` fact
// set is iranti saying "nothing here answers that." S3 COMPOSES that per-fact
// lexical signal with the semantic tier's emptiness and lifts the conjunction
// to ONE boolean. Ambient facts still flow (Option B); `abstain` is orthogonal
// to whether ambient context is present. The "fact hit suppresses abstention"
// case below is the direct assertion of that composition — a matched fact (the
// Layer 0f positive signal) makes abstain false even when chunks are empty.
//
// Harness mirrors src/tests/chunks-attend-read.test.ts (the S2 read-path test)
// EXACTLY: temp PGlite, IRANTI_EMBEDDER="mock" (deterministic trigram pseudo-
// vectors, no live Ollama), IRANTI_EXTRACT_SYNC="1" so attend() BLOCKS on its
// post-attend chain (which carries the S1 chunk write+embed) — a caller can
// therefore SEED a chunk with one attend and RETRIEVE/evaluate it with the next
// in the same process without racing the detached chain.
//
// Module-load-order care (same as chunks-attend-read.test.ts): connection.ts
// reads IRANTI_DB_ENGINE / IRANTI_DATA_DIR at import time and embed/index.ts
// reads IRANTI_EMBEDDER per call, so env is set before any dynamic import() of
// iranti internals. ensureContext memoizes ONE project + session per process
// (from cwd); attend scopes the chunk WRITE (currentProject) and READ
// (effectiveProjectIds, starting as [currentProject]) to that same project, so
// a chunk seeded here is in-scope for a later attend read. Unique, zero-
// keyword-overlap fixtures per assertion keep retrieval unambiguous.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-chunks-attend-abstain-"));

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

// The same paraphrase pair the S2 read test uses: zero keyword overlap, enough
// trigram overlap for the MockEmbedder to clear the 0.60 floor. RELATED_CHUNK
// is retrievable from PARAPHRASE_QUERY — so a query that DOES retrieve exists.
const RELATED_CHUNK =
  "user: the team refers to it as the sync wiki page for engineering coordination";
const PARAPHRASE_QUERY =
  "what is the nickname folks use for the shared collaboration record location";

// Gibberish shares no trigrams with any stored episode -> every candidate lands
// below the floor -> searchChunksSemantic returns [] -> the abstention gate
// fires. Same fixture family as chunks.test.ts:91 / chunks-attend-read.ts:185.
const GIBBERISH_QUERY = "xkqz vprmtlon quasar fluctuation zzytron bwg plough";

// Seed a chunk into the process-project's recall pool THROUGH the product write
// path (attend, phase post-response, S1), so the read/abstention logic under
// test evaluates exactly what a real ingest would have stored. IRANTI_EXTRACT_
// SYNC=1 makes attend await its post-attend chain, so on return the chunk is
// written AND embedded (mock) and immediately visible to a later attend.
async function seedChunkViaAttend(message: string): Promise<void> {
  const { attend } = await import("../mcp/tools/attend.js");
  await attend({
    entityHints: [{ entityType: "project", entityId: "core17-s3-seed" }],
    message,
    phase: "post-response",
  });
}

describe("CORE-17 S3 — attend abstention gate (MockEmbedder)", () => {
  it("OPEN gibberish with no matching fact ABSTAINS: abstain === true, chunks empty, no matched fact (the §S3 primary case)", async () => {
    const { attend } = await import("../mcp/tools/attend.js");

    // Put an on-topic episode in the pool so this is a genuine retrieval miss
    // (the tier ran and found nothing above the floor), not an empty store.
    await seedChunkViaAttend(RELATED_CHUNK);

    // A brand-new entity scope + a gibberish query: the router classifies OPEN
    // (no keyword/alias/correction hit), the embedder is on, searchChunksSemantic
    // runs and returns [] (everything below the 0.60 floor), and no fact matched
    // -> the abstention gate fires. mid-turn keeps this a PURE read (S1 gate:
    // mid-turn never seeds), so the gibberish text does not pollute the pool.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s3-abstain" }],
      message: GIBBERISH_QUERY,
      phase: "mid-turn",
    });

    // The explicit abstention signal is present and true — iranti saying, on
    // the AttendResult surface, "nothing here answers this."
    expect(result.abstain).toBe(true);
    // It rides on the S2 empty-chunk primitive: no chunk cleared the floor.
    expect(result.chunks).toBeUndefined();
    // ...and it composes with Layer 0f's "no matched fact" half: no fact matched.
    expect(result.facts.every((f) => !f.matched)).toBe(true);
  });

  it("OPEN paraphrase that DOES retrieve a chunk does NOT abstain (abstain absent): a hit suppresses the gate", async () => {
    const { attend } = await import("../mcp/tools/attend.js");

    // Fill the pool with a retrievable episode via the real write path.
    await seedChunkViaAttend(RELATED_CHUNK);

    // The paraphrase clears the floor for RELATED_CHUNK -> chunkHits is non-empty
    // -> the gate's "no chunk" precondition is false -> no abstention.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s3-hit" }],
      message: PARAPHRASE_QUERY,
      phase: "mid-turn",
    });

    // Sanity: the retrieval actually happened (else the suppression is vacuous).
    expect(result.chunks).toBeDefined();
    expect(result.chunks!.length).toBeGreaterThan(0);
    // Omitted-when-false: a retrieved chunk means iranti is NOT abstaining.
    expect(result.abstain).toBeUndefined();
  });

  it("STRUCTURED query with a real fact hit does NOT abstain even when chunks are empty (a fact answered it — the Layer 0f composition)", async () => {
    const { attend } = await import("../mcp/tools/attend.js");

    // Seed a fact via a URL artifact (attend extracts URLs deterministically
    // under a `shared-url:<hash>` key). matched is a KEY-token claim (Layer 0f):
    // a query naming the key's nouns ("shared url") is the canonical STRUCTURED
    // case the router keeps on the exact-first path.
    const url = "https://example.com/core17-s3-structured-probe";
    await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s3-struct" }],
      message: `the design doc lives at ${url}`,
      phase: "post-response",
    });

    // A query that KEY-token-overlaps the stored artifact -> matchedFactIds is
    // non-empty -> router classifies STRUCTURED -> chunk read is skipped
    // (chunks omitted). The abstention gate must NOT fire: a fact answered it,
    // so a bare "no chunk" must never be mistaken for "no answer" (D-ABSTAIN
    // requires BOTH no chunk AND no matched fact). This is exactly the
    // over-abstention risk the plan's test case (3) pins.
    const result = await attend({
      entityHints: [{ entityType: "project", entityId: "core17-s3-struct" }],
      message: `what is the shared url we saved`,
      phase: "mid-turn",
    });

    // The STRUCTURED precondition genuinely held (a fact matched)...
    expect(result.facts.some((f) => f.matched)).toBe(true);
    // ...chunks are omitted on the exact-first path (STRUCTURED contract)...
    expect(result.chunks).toBeUndefined();
    // ...and crucially, abstain is NOT set — the matched fact suppressed it.
    expect(result.abstain).toBeUndefined();
  });

  it("embedder OFF: an OPEN gibberish query does NOT abstain (field absent) — meaningful only when the tier ran; off-path byte-identical", async () => {
    // With the embedder off the semantic tier never runs, so `abstain` would be
    // a false "I checked and found nothing" when nothing was checked. The
    // isEmbedderActive() guard leaves the field absent -> today's exact shape.
    await seedChunkViaAttend(RELATED_CHUNK); // seeded under mock, for realism

    process.env["IRANTI_EMBEDDER"] = "off";
    try {
      const { attend } = await import("../mcp/tools/attend.js");
      const result = await attend({
        entityHints: [{ entityType: "project", entityId: "core17-s3-off" }],
        message: GIBBERISH_QUERY,
        phase: "mid-turn",
      });
      // No embedder -> gate not evaluated -> field absent (not `true`, not
      // `false`) — the byte-identical-when-off guarantee for the S3 field.
      expect(result.abstain).toBeUndefined();
    } finally {
      process.env["IRANTI_EMBEDDER"] = "mock"; // restore for later cases
    }
  });

  it("byte-identical guard: for the SAME OPEN gibberish query, everything EXCEPT the S2/S3 additive fields is identical embedder-on vs embedder-off", async () => {
    // The on run fires the abstention gate (adds abstain:true, no chunks); the
    // off run adds neither. Stripping BOTH additive fields (chunks + abstain)
    // must leave two deep-equal payloads — proving S3, like S2, perturbs nothing
    // on the deterministic/off path (plan §S3 criterion 4, mirroring the S2
    // read test's additive-only proof).
    const { attend } = await import("../mcp/tools/attend.js");

    // A pool with an on-topic chunk, so the ON run genuinely evaluates the tier
    // and abstains on a gibberish miss (making "everything else identical"
    // meaningful).
    await seedChunkViaAttend(RELATED_CHUNK);

    const args = {
      entityHints: [{ entityType: "project", entityId: "core17-s3-byteid" }],
      message: GIBBERISH_QUERY,
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

    // The ON run abstained (tier ran, found nothing above floor, no fact)...
    expect(onResult.abstain).toBe(true);
    expect(onResult.chunks).toBeUndefined();
    // ...the OFF run did not evaluate the tier (field absent)...
    expect(offResult.abstain).toBeUndefined();

    // ...and stripping the additive S2/S3 fields leaves byte-identical payloads.
    // nextDue is deterministic from phase; projectState is a once-per-process
    // latch both calls see the same way. No other field may differ.
    const stripAdditive = (r: typeof onResult) => {
      const { chunks: _c, abstain: _a, ...rest } = r;
      return rest;
    };
    expect(stripAdditive(onResult)).toStrictEqual(stripAdditive(offResult));
  });
});
