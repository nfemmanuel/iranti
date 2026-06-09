// Integration tests — entities.ts

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { getEntity, upsertEntity } from "../library/entities.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------

describe("upsertEntity", () => {
  it("creates a new entity and returns it", async () => {
    const entityId = randomUUID();

    const entity = await upsertEntity("project", entityId, "My Test Project");

    expect(entity.entityType).toBe("project");
    expect(entity.entityId).toBe(entityId);
    expect(entity.label).toBe("My Test Project");
    expect(entity.createdAt).toBeInstanceOf(Date);
  });

  it("returns the same record when called twice with the same type + id", async () => {
    const entityId = randomUUID();

    const e1 = await upsertEntity("user", entityId);
    const e2 = await upsertEntity("user", entityId);

    // Same underlying row — must have the same primary key
    expect(e1.id).toBe(e2.id);
  });

  it("updates the label when called again with a new label", async () => {
    const entityId = randomUUID();

    await upsertEntity("project", entityId, "Old Label");
    const updated = await upsertEntity("project", entityId, "New Label");

    expect(updated.label).toBe("New Label");
  });
});

// ---------------------------------------------------------------------------

describe("getEntity", () => {
  it("returns the entity by type + id", async () => {
    const entityId = randomUUID();
    await upsertEntity("user", entityId, "Alice");

    const found = await getEntity("user", entityId);

    expect(found).toBeDefined();
    expect(found?.entityType).toBe("user");
    expect(found?.entityId).toBe(entityId);
    expect(found?.label).toBe("Alice");
  });

  it("returns undefined when no entity matches type + id", async () => {
    const result = await getEntity("user", "__no-such-user-xyzzy__");

    expect(result).toBeUndefined();
  });
});
