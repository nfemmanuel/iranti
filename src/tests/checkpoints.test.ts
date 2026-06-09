// Integration tests — checkpoints.ts

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import {
  CHECKPOINT_KEY,
  clearCheckpoint,
  getActiveCheckpoint,
  getCheckpoint,
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
