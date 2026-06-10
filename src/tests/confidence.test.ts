// Confidence plumbing tests — Phase 2.5 (CORE-27)
//
// Verifies the D7 formula: stored = clamp(base × (0.5 + sourceScore), 0, 1).
// An explicit write from a neutral source (score 0.5) must still store 1.0.
// An extracted fact (base 0.85) from a trusted source must be > 0.85.
// A distrusted source must reduce confidence.

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { writeFact, findFact } from "../library/facts.js";
import { recordOutcome } from "../library/source-reliability.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

describe("writeFact — D7 confidence formula (CORE-27)", () => {
  it("neutral source (score 0.5): explicit write stores confidence ≈ 1.0", async () => {
    const entityId = randomUUID();
    const source = `neutral-src-${randomUUID()}`;

    // Source has no history → score defaults to 0.5.
    // formula: 1.0 × (0.5 + 0.5) = 1.0
    await writeFact({ entityType: "project", entityId, key: "lang", value: "TypeScript", source });

    const fact = await findFact("project", entityId, "lang");
    expect(fact).toBeDefined();
    expect(fact!.confidence).toBeCloseTo(1.0, 4);
  });

  it("extractor confidence 0.85 with neutral source stores ≈ 0.85", async () => {
    const entityId = randomUUID();
    const source = `neutral-extract-${randomUUID()}`;

    // formula: 0.85 × (0.5 + 0.5) = 0.85
    await writeFact({
      entityType: "project",
      entityId,
      key: "decision:framework",
      value: "use-react",
      source,
      confidence: 0.85,
    });

    const fact = await findFact("project", entityId, "decision:framework");
    expect(fact).toBeDefined();
    expect(fact!.confidence).toBeCloseTo(0.85, 4);
  });

  it("trusted source (score ≈ 0.9) boosts confidence toward 1.0", async () => {
    const entityId = randomUUID();
    const trustedSrc = `trusted-${randomUUID()}`;

    // Boost the source to ~0.9 with 4 wins.
    for (let i = 0; i < 4; i++) {
      await recordOutcome(trustedSrc, `dummy-${i}`);
    }
    // score ≈ 4/5 = 0.8 → formula: 0.85 × (0.5 + 0.8) = 0.85 × 1.3 → clamped to 1.0
    await writeFact({
      entityType: "project",
      entityId,
      key: "preference:editor",
      value: "vscode",
      source: trustedSrc,
      confidence: 0.85,
    });

    const fact = await findFact("project", entityId, "preference:editor");
    expect(fact).toBeDefined();
    // clamped to 1.0
    expect(fact!.confidence).toBeCloseTo(1.0, 4);
  });

  it("distrusted source reduces confidence below base", async () => {
    const entityId = randomUUID();
    const weakSrc = `weak-${randomUUID()}`;

    // Make the source lose 3 times to drop score.
    for (let i = 0; i < 3; i++) {
      await recordOutcome(`winner-${randomUUID()}`, weakSrc);
    }
    // score ≈ 0 / (0+3) → ~0 → formula: 1.0 × (0.5 + ~0) = ~0.5
    await writeFact({
      entityType: "project",
      entityId,
      key: "stack",
      value: "node",
      source: weakSrc,
    });

    const fact = await findFact("project", entityId, "stack");
    expect(fact).toBeDefined();
    // confidence should be notably less than 1.0 (around 0.5)
    expect(fact!.confidence).toBeLessThan(0.8);
  });
});
