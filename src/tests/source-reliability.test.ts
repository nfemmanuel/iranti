// Source reliability tests — Phase 2b

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { getScore, getReliabilityRow, recordOutcome, DEFAULT_SCORE } from "../library/source-reliability.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

describe("source reliability", () => {
  it("unknown source returns DEFAULT_SCORE (0.5)", async () => {
    const score = await getScore(`unknown-${randomUUID()}`);
    expect(score).toBeCloseTo(DEFAULT_SCORE);
  });

  it("getReliabilityRow returns undefined for new source", async () => {
    const row = await getReliabilityRow(`fresh-${randomUUID()}`);
    expect(row).toBeUndefined();
  });

  it("first win sets score > 0.5", async () => {
    const winner = `winner-${randomUUID()}`;
    const loser = `loser-${randomUUID()}`;

    await recordOutcome(winner, loser);

    const winnerScore = await getScore(winner);
    const loserScore = await getScore(loser);

    expect(winnerScore).toBeGreaterThan(DEFAULT_SCORE);
    expect(loserScore).toBeLessThan(DEFAULT_SCORE);
  });

  it("wins accumulate — more wins = higher score", async () => {
    const source = `accumulate-${randomUUID()}`;

    await recordOutcome(source, "dummy-opp");
    const after1 = await getScore(source);

    await recordOutcome(source, "dummy-opp");
    const after2 = await getScore(source);

    expect(after2).toBeGreaterThanOrEqual(after1);
  });

  it("score approaches 1.0 with many wins", async () => {
    const source = `dominant-${randomUUID()}`;

    for (let i = 0; i < 8; i++) {
      await recordOutcome(source, "dummy");
    }

    const score = await getScore(source);
    expect(score).toBeGreaterThan(0.8);
  });

  it("score approaches 0 with many losses", async () => {
    const source = `weak-${randomUUID()}`;
    const other = `other-${randomUUID()}`;

    for (let i = 0; i < 8; i++) {
      await recordOutcome(other, source);
    }

    const score = await getScore(source);
    expect(score).toBeLessThan(0.2);
  });

  it("wins and losses are tracked separately", async () => {
    const source = `mixed-${randomUUID()}`;

    await recordOutcome(source, "x");
    await recordOutcome(source, "x");
    await recordOutcome("y", source);

    const row = await getReliabilityRow(source);
    expect(row).toBeDefined();
    expect(row!.wins).toBe(2);
    expect(row!.losses).toBe(1);
    // score = 2 / (2 + 1) = 0.667
    expect(row!.score).toBeCloseTo(2 / 3, 1);
  });

  it("score is deterministic — same outcomes → same score", async () => {
    const srcA = `det-a-${randomUUID()}`;
    const srcB = `det-b-${randomUUID()}`;

    await recordOutcome(srcA, "x");
    await recordOutcome(srcB, "x");

    expect(await getScore(srcA)).toBeCloseTo(await getScore(srcB));
  });
});
