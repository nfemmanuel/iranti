// iranti init — Layer 0 (D8), library-function tests.
//
// runInit() is pure config-file I/O: no database, no MCP server. Uses a
// real scratch "home dir" per test (via the homeDir option) so nothing
// touches the developer's actual ~/.iranti/config.json.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInitConfig, runInit } from "../library/setup.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "iranti-init-home-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("runInit", () => {
  it("creates ~/.iranti/config.json with the given projectsRoot", async () => {
    const projectsRoot = path.join(homeDir, "Projects");

    const result = await runInit({ projectsRoot, homeDir });

    expect(result.created).toBe(true);
    expect(result.config.projectsRoot).toBe(path.resolve(projectsRoot));

    const raw = readFileSync(result.configPath, "utf-8");
    const parsed = JSON.parse(raw) as { projectsRoot?: string };
    expect(parsed.projectsRoot).toBe(path.resolve(projectsRoot));
  });

  it("is idempotent: running it twice with the same options produces the same file", async () => {
    const projectsRoot = path.join(homeDir, "Projects");

    const first = await runInit({ projectsRoot, homeDir });
    const second = await runInit({ projectsRoot, homeDir });

    expect(second.created).toBe(false);
    expect(second.config).toEqual(first.config);
  });

  it("merges: setting dataDir alone does not clobber a previously configured projectsRoot", async () => {
    const projectsRoot = path.join(homeDir, "Projects");
    const dataDir = path.join(homeDir, "data");

    await runInit({ projectsRoot, homeDir });
    const updated = await runInit({ dataDir, homeDir });

    expect(updated.config.projectsRoot).toBe(path.resolve(projectsRoot));
    expect(updated.config.dataDir).toBe(path.resolve(dataDir));
  });

  it("does NOT touch the database or require one to be running", async () => {
    // No IRANTI_DB_ENGINE / IRANTI_DATA_DIR / DATABASE_URL setup at all —
    // if runInit accidentally imported db/connection.js this would either
    // throw or hang. It does neither.
    const projectsRoot = path.join(homeDir, "AnotherRoot");
    await expect(runInit({ projectsRoot, homeDir })).resolves.toBeDefined();
  });
});

describe("readInitConfig", () => {
  it("returns an empty object when no config file exists yet (zero-config default)", async () => {
    const config = await readInitConfig(homeDir);
    expect(config).toEqual({});
  });

  it("reads back what runInit wrote", async () => {
    const projectsRoot = path.join(homeDir, "Projects");
    await runInit({ projectsRoot, homeDir });

    const config = await readInitConfig(homeDir);
    expect(config.projectsRoot).toBe(path.resolve(projectsRoot));
  });

  it("never throws on a corrupt config file", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const irantiDir = path.join(homeDir, ".iranti");
    mkdirSync(irantiDir, { recursive: true });
    writeFileSync(path.join(irantiDir, "config.json"), "{not valid json", "utf-8");

    await expect(readInitConfig(homeDir)).resolves.toEqual({});
  });
});
