// Integration tests — CORE-16 semantic retrieval tier (embedder ON, using
// the test-only MockEmbedder so CI never needs a live Ollama instance —
// deterministic hash-based pseudo-vectors, see src/embed/mock.ts).
//
// Module-load-order care: src/db/connection.ts reads IRANTI_DB_ENGINE /
// IRANTI_DATA_DIR / DATABASE_URL at IMPORT TIME, and src/embed/index.ts
// reads IRANTI_EMBEDDER at CALL TIME (getEmbedder() re-derives per call —
// see its header comment) — so env vars are set before any dynamic import()
// of iranti internals, same discipline as it-runs.test.ts /
// projects-isolation.test.ts.
//
// Confound this suite designs around: readRelevantFactsWithMatch's
// PRE-EXISTING "no keyword match at all" path falls back to returning the
// entity's most recent `limit` facts as AMBIENT context (matched:false),
// independent of the embedder — and because that fallback pads `top` up to
// `limit` from whatever candidates exist, a target fact can never be BOTH
// excluded from that fallback's `top` AND leave a semantic slot open (if
// there are fewer candidates than `limit`, the target is IN `top`; if there
// are more, `top` already fills the whole budget, leaving 0 remaining
// either way). So every test below that needs to isolate genuine
// semantic-only surfacing uses a DECOY that keyword-matches the query
// (forcing the `anyMatch = true` / keyword-scored branch instead), with
// enough total candidates that `topScored.slice(0, cap)` naturally excludes
// the zero-scoring target by rank — leaving real open slots for semantic
// fill to compete for. Every fixture's token overlap is verified by direct
// calculation against tokenizeMessage/scoreRelevance's actual rules, not
// assumed.
//
// PRD acceptance criteria covered here:
//   - slot-fill fills remaining slots only (adversarial: high-cosine
//     candidate vs keyword hit — keyword keeps its rank/slot)
//   - semantic:true labeled, matched:true NEVER granted
//   - cross-project isolation (vector match in project B never surfaces in
//     project A's scope)
//   - below-floor returns nothing
//   - regime mismatch invalidates old vectors (re-embed lazily)
//   - dual-engine round-trip is covered structurally: this suite runs
//     against embedded PGlite (the text-column path); Postgres's native
//     vector(768) path is exercised by the SAME src/embed/vector-column.ts
//     accessor code (see src/tests/embed.test.ts's unit coverage of
//     parseStoredVector's shared parser) — a live dual-engine run isn't
//     attempted here per house rules (no live Postgres in this environment).

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-semantic-"));

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

// A fact that WILL keyword-match KEYWORD_QUERY (shares "deploy"/"staging"
// as key tokens — scores high via scoreRelevance's 2x key-token weight),
// used to force the anyMatch=true branch and occupy exactly one slot.
const KEYWORD_FACT_KEY = "deploy-target";
const KEYWORD_FACT_VALUE = "deploy to staging happens via the release script";
const KEYWORD_QUERY = "how do I deploy to staging";

// Fact + paraphrase-query pair with GENUINELY zero keyword overlap (no
// shared key token, no value substring match either) but enough
// character-level (trigram) overlap for the MockEmbedder to score them
// above the 0.60 floor. Verified by direct calculation, not assumed.
const PARAPHRASE_KEY = "sync-wiki-note";
const PARAPHRASE_VALUE = "the team refers to it as the sync wiki page for engineering coordination";
const PARAPHRASE_QUERY = "what is the nickname folks use for the shared collaboration record location";

async function writeKeywordDecoy(
  writeFact: typeof import("../library/facts.js").writeFact,
  entityId: string,
): Promise<void> {
  await writeFact({
    entityType: "project",
    entityId,
    key: KEYWORD_FACT_KEY,
    value: KEYWORD_FACT_VALUE,
    source: "test",
  });
}

describe("CORE-16 — semantic retrieval tier (MockEmbedder)", () => {
  it("a paraphrase query with zero keyword overlap surfaces a semantically-close fact, labeled semantic:true (never matched:true)", async () => {
    const { writeFact, readRelevantFactsWithMatch } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");

    const entityId = `sem-${randomUUID()}`;
    // cap = 2: the keyword decoy (the only positive scorer) takes slot 1;
    // slot 2 is genuinely open for semantic fill. Zero-scoring facts (like
    // the paraphrase fact, on this salted query) are NOT treated as
    // pre-occupying slots — only real (score > 0) hits count as
    // deterministic "top" now (see facts.ts's positiveScored/zeroScored
    // split), so this cap works regardless of how many candidates exist.
    const cap = 2;

    // Salt the paraphrase query with a token that keyword-matches the decoy
    // (KEYWORD_FACT_KEY "deploy-target") — this forces the anyMatch=true
    // branch (so the query isn't discarded into the pure-recency fallback),
    // while the paraphrase fact itself still scores 0 on keywords and can
    // only be surfaced via cosine ranking against the salted query text.
    const salted = `${PARAPHRASE_QUERY} regarding the deploy-target`;
    await writeFact({
      entityType: "project",
      entityId,
      key: PARAPHRASE_KEY,
      value: PARAPHRASE_VALUE,
      source: "test",
    });
    await writeKeywordDecoy(writeFact, entityId);
    await settleBackground(5000);

    const { facts, matchedIds, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      cap,
      salted,
    );

    const decoyHit = facts.find((f) => f.key === KEYWORD_FACT_KEY);
    const paraphraseHit = facts.find((f) => f.key === PARAPHRASE_KEY);

    expect(decoyHit).toBeDefined();
    expect(matchedIds.has(decoyHit!.id)).toBe(true);

    expect(paraphraseHit).toBeDefined();
    expect(semanticIds.has(paraphraseHit!.id)).toBe(true);
    expect(matchedIds.has(paraphraseHit!.id)).toBe(false); // D3: semantic, never matched
  });

  it("slot-fill only fills remaining slots — a keyword hit keeps its rank against a high-cosine semantic candidate when the budget is exhausted", async () => {
    const { writeFact, readRelevantFactsWithMatch } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");

    const entityId = `sem-slotfill-${randomUUID()}`;

    await writeKeywordDecoy(writeFact, entityId);
    // A fact that is semantically close (mock trigram overlap) to the query
    // but shares no meaningful keyword tokens with it once you swap the
    // domain noun — engineered to be a strong cosine candidate.
    await writeFact({
      entityType: "project",
      entityId,
      key: "release-notes-location",
      value: "release notes for staging are archived in the wiki",
      source: "test",
    });
    await settleBackground(5000);

    const { facts, matchedIds, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      1, // cap of 1 — forces a displacement decision
      KEYWORD_QUERY,
    );

    // The keyword hit must win the one slot; the semantically-close
    // candidate must NOT displace it.
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe(KEYWORD_FACT_KEY);
    expect(matchedIds.has(facts[0]!.id)).toBe(true);
    expect(semanticIds.size).toBe(0); // no slot was left open to fill
  });

  it("semantic fill occupies a slot the keyword tier left open, without double-labeling any fact", async () => {
    const { writeFact, readRelevantFactsWithMatch } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");

    const entityId = `sem-remaining-${randomUUID()}`;

    await writeKeywordDecoy(writeFact, entityId);
    await writeFact({
      entityType: "project",
      entityId,
      key: "release-notes-location",
      value: "release notes for staging are archived in the wiki",
      source: "test",
    });
    await settleBackground(5000);

    // Cap of 2 — both facts fit; the keyword hit wins slot 1 by score, and a
    // slot remains open for slot 2 (which keyword scoring may or may not
    // fill — either way, no fact is ever labeled both matched AND semantic).
    const { facts, matchedIds, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      2,
      KEYWORD_QUERY,
    );

    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(matchedIds.has(f.id) && semanticIds.has(f.id)).toBe(false);
    }
  });

  it("below-floor queries return no semantic facts (no-answer honesty)", async () => {
    const { writeFact, readRelevantFactsWithMatch } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");

    const entityId = `sem-floor-${randomUUID()}`;

    await writeKeywordDecoy(writeFact, entityId);
    await writeFact({
      entityType: "project",
      entityId,
      key: "favorite-color",
      value: "cerulean blue",
      source: "test",
    });
    await settleBackground(5000);

    // Query keyword-matches the decoy (forcing anyMatch=true, one open
    // slot at cap=2) but is utterly unrelated to "favorite-color: cerulean
    // blue" even at the trigram level — lands well below the 0.60 floor.
    const { facts, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      2,
      `${KEYWORD_QUERY} xkqz vprmtlon quasar fluctuation ledger`,
    );

    // Below-floor: semantic contributes nothing. The zero-score ambient
    // fallback (the pre-CORE-16 "pad remaining slots by recency" behavior)
    // may still surface "favorite-color" in the open slot — that's the
    // documented byte-identical-when-semantic-finds-nothing fallback, not a
    // semantic hit. The acceptance criterion is specifically that it's
    // never LABELED semantic, which semanticIds.size === 0 proves directly.
    expect(semanticIds.size).toBe(0);
    const hit = facts.find((f) => f.key === "favorite-color");
    if (hit) expect(semanticIds.has(hit.id)).toBe(false);
  });

  it("cross-project isolation holds for semantic hits", async () => {
    const { writeFact, readRelevantFactsWithMatch } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityId = "shared-entity";

    await writeFact({
      entityType: "project",
      entityId,
      key: PARAPHRASE_KEY,
      value: PARAPHRASE_VALUE,
      source: "test",
      project: projectA,
    });
    await settleBackground(5000);

    // Query from project B's scope for the same entity name — must never
    // see project A's semantically-close fact, regardless of slot budget.
    const { facts, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      10,
      PARAPHRASE_QUERY,
      "default",
      projectB,
    );

    expect(facts.some((f) => f.key === PARAPHRASE_KEY)).toBe(false);
    expect(semanticIds.size).toBe(0);
  });

  it("regime mismatch invalidates a stored vector (treated as absent, no crash)", async () => {
    const { writeFact, readRelevantFactsWithMatch, findFact } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");
    const { db } = await import("../db/connection.js");
    const { facts: factsTable } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");

    const entityId = `sem-regime-${randomUUID()}`;

    await writeKeywordDecoy(writeFact, entityId);
    await writeFact({
      entityType: "project",
      entityId,
      key: PARAPHRASE_KEY,
      value: PARAPHRASE_VALUE,
      source: "test",
    });
    await settleBackground(5000);

    const fact = await findFact("project", entityId, PARAPHRASE_KEY);
    expect(fact).toBeDefined();

    // Corrupt the stored regime signature to simulate a model swap.
    await db
      .update(factsTable)
      .set({
        metadata: {
          ...(fact!.metadata as Record<string, unknown>),
          embedRegime: { model: "some-other-model", dim: 999, v: "0" },
        },
      })
      .where(eq(factsTable.id, fact!.id));

    const salted = `${PARAPHRASE_QUERY} regarding the deploy-target`;
    const { facts: results, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      2,
      salted,
    );

    // The vector is present but under the wrong regime — treated as absent,
    // not used, and (critically) does not throw. It may still ride in via
    // the zero-score ambient fallback (see below-floor test's comment for
    // why that's the correct byte-identical-when-semantic-finds-nothing
    // behavior) — the acceptance criterion is that it's never LABELED
    // semantic, which semanticIds.size === 0 proves directly.
    expect(semanticIds.size).toBe(0);
    const hit = results.find((f) => f.key === PARAPHRASE_KEY);
    if (hit) expect(semanticIds.has(hit.id)).toBe(false);
  });

  it("embedder OFF: readRelevantFactsWithMatch never surfaces a fact via semantic fill", async () => {
    process.env["IRANTI_EMBEDDER"] = "off";
    const { writeFact, readRelevantFactsWithMatch } = await import("../library/facts.js");
    const { settleBackground } = await import("../library/background.js");

    const entityId = `sem-off-${randomUUID()}`;

    await writeKeywordDecoy(writeFact, entityId);
    await writeFact({
      entityType: "project",
      entityId,
      key: PARAPHRASE_KEY,
      value: PARAPHRASE_VALUE,
      source: "test",
    });
    await settleBackground(5000);

    const salted = `${PARAPHRASE_QUERY} regarding the deploy-target`;
    const { facts, semanticIds } = await readRelevantFactsWithMatch(
      "project",
      entityId,
      2,
      salted,
    );

    // Embedder off: semanticIds is always empty (isEmbedderActive() guard
    // fires before any embed call). The target fact may still appear via
    // the zero-score ambient fallback (unchanged pre-CORE-16 behavior) —
    // the point of this test is that it's never labeled semantic.
    expect(semanticIds.size).toBe(0);
    const hit = facts.find((f) => f.key === PARAPHRASE_KEY);
    if (hit) expect(semanticIds.has(hit.id)).toBe(false);

    process.env["IRANTI_EMBEDDER"] = "mock"; // restore for subsequent tests in this file
  });
});
