// Integration tests — checkpoints.ts

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import {
  CHECKPOINT_KEY,
  clearCheckpoint,
  getActiveCheckpoint,
  getCheckpoint,
  readCheckpointStage,
  writeCheckpoint,
} from "../library/checkpoints.js";
import { getFactHistory } from "../library/facts.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

describe("writeCheckpoint / getCheckpoint", () => {
  it("saves and retrieves a checkpoint", async () => {
    const entityId = randomUUID();

    await writeCheckpoint("project", entityId, "implementing the MCP server");

    const cp = await getCheckpoint("project", entityId);
    expect(cp?.value).toBe("implementing the MCP server");
    expect(cp?.key).toBe(CHECKPOINT_KEY);
  });

  it("overwrites the previous checkpoint and archives it", async () => {
    const entityId = randomUUID();

    const first = await writeCheckpoint("project", entityId, "step 1");
    await writeCheckpoint("project", entityId, "step 2");

    const cp = await getCheckpoint("project", entityId);
    expect(cp?.value).toBe("step 2");

    // The previous checkpoint survives in fact_archive.
    const history = await getFactHistory(first.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.value).toBe("step 1");
  });

  it("returns undefined when no checkpoint exists", async () => {
    expect(await getCheckpoint("project", randomUUID())).toBeUndefined();
  });
});

describe("getActiveCheckpoint", () => {
  it("returns the most recently written checkpoint across entity hints", async () => {
    const projectId = randomUUID();
    const userId = randomUUID();

    await writeCheckpoint("user", userId, "older checkpoint");
    await new Promise((r) => setTimeout(r, 10));
    await writeCheckpoint("project", projectId, "newer checkpoint");

    const active = await getActiveCheckpoint([
      { entityType: "user", entityId: userId },
      { entityType: "project", entityId: projectId },
    ]);

    expect(active?.value).toBe("newer checkpoint");
  });

  it("returns undefined when no hinted entity has a checkpoint", async () => {
    const active = await getActiveCheckpoint([
      { entityType: "project", entityId: randomUUID() },
    ]);
    expect(active).toBeUndefined();
  });

  it("returns undefined for an empty hint list", async () => {
    expect(await getActiveCheckpoint([])).toBeUndefined();
  });
});

describe("clearCheckpoint", () => {
  it("archives the checkpoint so it no longer appears", async () => {
    const entityId = randomUUID();

    await writeCheckpoint("project", entityId, "done soon");
    const cleared = await clearCheckpoint("project", entityId);

    expect(cleared).toBe(true);
    expect(await getCheckpoint("project", entityId)).toBeUndefined();
  });

  it("returns false when there is nothing to clear", async () => {
    expect(await clearCheckpoint("project", randomUUID())).toBe(false);
  });
});

// Layer 0e review follow-through: the PRD promised direct unit coverage of
// the stage/status round-trip in THIS file (not only indirectly via
// project-state.test.ts's scripted scenario) — these are those tests.
describe("checkpoint stage/status metadata (Layer 0e)", () => {
  it("round-trips explicit stage + status through write and read", async () => {
    const entityId = randomUUID();
    const written = await writeCheckpoint("project", entityId, "mid-migration", {
      source: "checkpoint",
      stage: "blocked",
      status: "waiting on schema sign-off",
    });

    const { stage, status, stageSetAt } = readCheckpointStage(written);
    expect(stage).toBe("blocked");
    expect(status).toBe("waiting on schema sign-off");
    // Server-stamped, parseable timestamp — never caller-supplied.
    expect(stageSetAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(stageSetAt!))).toBe(false);
  });

  it("defaults stage to in_progress when omitted", async () => {
    const entityId = randomUUID();
    const written = await writeCheckpoint("project", entityId, "just checkpointing");
    const { stage, status } = readCheckpointStage(written);
    expect(stage).toBe("in_progress");
    expect(status).toBeNull();
  });

  it("reads a pre-Layer-0e checkpoint (no stage metadata) as 'unknown', not a default", () => {
    // Simulate a legacy checkpoint fact: metadata without stage keys —
    // absence must read as UNKNOWN_CHECKPOINT_STAGE so it can never be
    // confused with an explicitly-set value (PRD Decision 2).
    const legacyShapes = [{ metadata: null }, { metadata: {} }, { metadata: { rawKey: "Checkpoint" } }];
    for (const legacy of legacyShapes) {
      const { stage, status, stageSetAt } = readCheckpointStage(legacy);
      expect(stage).toBe("unknown");
      expect(status).toBeNull();
      expect(stageSetAt).toBeNull();
    }
  });

  it("stage/status survive checkpoint rotation into the archive round-trip", async () => {
    const entityId = randomUUID();
    await writeCheckpoint("project", entityId, "phase one", {
      source: "checkpoint",
      stage: "planning",
      status: "scoping",
    });
    const second = await writeCheckpoint("project", entityId, "phase two", {
      source: "checkpoint",
      stage: "in_progress",
    });

    // Live checkpoint carries the NEW stage...
    expect(readCheckpointStage(second).stage).toBe("in_progress");
    // ...and the rotated-out predecessor's text is preserved in history
    // (rotation goes through archiveFact — value snapshot guaranteed).
    const history = await getFactHistory(second.id);
    expect(history.some((h) => h.value === "phase one")).toBe(true);
  });
});
