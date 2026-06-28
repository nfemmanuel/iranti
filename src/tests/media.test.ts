// Media storage and vision tests — OD-4.
//
// Unit tests for LocalFsStorageBackend, NullVisionBackend, and
// LocalLlmVisionBackend degrade path. All tests are pure (no DB required).
// Integration tests (ingestMedia against the DB) are skipped when DB is offline.

import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStorageBackend } from "../media/storage.js";
import { NullVisionBackend, LocalLlmVisionBackend } from "../media/vision.js";

// ---------------------------------------------------------------------------
// LocalFsStorageBackend — put / get / delete / resolveUrl
// ---------------------------------------------------------------------------

describe("LocalFsStorageBackend", () => {
  let tmpRoot: string;
  let backend: LocalFsStorageBackend;

  // Use a real temp directory per test suite so tests are isolated.
  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  it("put returns a file:// ref and correct sizeBytes", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "iranti-media-test-"));
    backend = new LocalFsStorageBackend(tmpRoot);

    const bytes = Buffer.from("PNG_FAKE_BYTES", "utf8");
    const result = await backend.put(bytes, {
      mime: "image/png",
      entityType: "project",
      entityId: "test-proj",
      normalizedKey: "screenshot:login",
    });

    expect(result.ref).toMatch(/^file:\/\//);
    expect(result.sizeBytes).toBe(bytes.length);
  });

  it("get round-trips the exact bytes", async () => {
    const bytes = Buffer.from("ROUND_TRIP_DATA_12345");
    const { ref } = await backend.put(bytes, {
      mime: "image/jpeg",
      entityType: "user",
      entityId: "alice",
      normalizedKey: "avatar",
    });

    const retrieved = await backend.get(ref);
    expect(retrieved.equals(bytes)).toBe(true);
  });

  it("resolveUrl returns an absolute path string", () => {
    // Use the ref from the first put.
    const fakeRef = "file://default/project/test-proj/screenshot-login/fake.png";
    const url = backend.resolveUrl(fakeRef);
    expect(url).toContain("default");
    expect(url).not.toMatch(/^file:\/\//); // resolveUrl strips the scheme
  });

  it("ref includes normalizedKey in the path (colon encoded as __)", async () => {
    const bytes = Buffer.from("test");
    const { ref } = await backend.put(bytes, {
      mime: "image/png",
      entityType: "project",
      entityId: "p1",
      normalizedKey: "diagram:architecture",
    });
    // Colon is Windows-unsafe in paths, so it's encoded as __ in the ref.
    expect(ref).toContain("diagram__architecture");
  });

  it("two puts of the same key produce different refs (uuid-based)", async () => {
    const bytes = Buffer.from("same content");
    const r1 = await backend.put(bytes, {
      mime: "image/png",
      entityType: "project",
      entityId: "p1",
      normalizedKey: "screenshot:home",
    });
    const r2 = await backend.put(bytes, {
      mime: "image/png",
      entityType: "project",
      entityId: "p1",
      normalizedKey: "screenshot:home",
    });
    expect(r1.ref).not.toBe(r2.ref);
  });

  it("delete removes the file (get throws afterwards)", async () => {
    const bytes = Buffer.from("delete me");
    const { ref } = await backend.put(bytes, {
      mime: "image/png",
      entityType: "project",
      entityId: "p1",
      normalizedKey: "temp:delete-test",
    });

    await backend.delete(ref);
    await expect(backend.get(ref)).rejects.toThrow();
  });

  it("delete is non-fatal on a ref that does not exist", async () => {
    await expect(
      backend.delete("file://default/project/x/y/nonexistent.png"),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// NullVisionBackend — always returns null
// ---------------------------------------------------------------------------

describe("NullVisionBackend", () => {
  const v = new NullVisionBackend();

  it("returns null for any image bytes", async () => {
    const result = await v.describe(Buffer.from("PNG"), "image/png");
    expect(result).toBeNull();
  });

  it("returns null for non-image mime", async () => {
    const result = await v.describe(Buffer.from("pdf content"), "application/pdf");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LocalLlmVisionBackend — degrade on unreachable endpoint
// ---------------------------------------------------------------------------

describe("LocalLlmVisionBackend — graceful degradation", () => {
  it("returns null when the Ollama endpoint is unreachable", async () => {
    const v = new LocalLlmVisionBackend("http://localhost:19999", "llava");
    const result = await v.describe(Buffer.from("PNG"), "image/png");
    expect(result).toBeNull();
  });

  it("returns null for non-image mime (no vision call made)", async () => {
    const v = new LocalLlmVisionBackend("http://localhost:19999", "llava");
    const result = await v.describe(Buffer.from("pdf"), "application/pdf");
    expect(result).toBeNull();
  });
});
