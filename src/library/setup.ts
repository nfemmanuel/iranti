// iranti init — Layer 0 (D8: convenience, never a requirement).
//
// Writes/updates the host config file at ~/.iranti/config.json:
// { projectsRoot, dataDir }. This is the "set up once for the whole
// Projects folder" convenience — it does NOT touch the database and does
// NOT require a running MCP server, so it can run before the store has
// ever been opened. With no config at all, iranti still works: the store
// boots and auto-migrates on first real MCP use (src/db/connection.ts),
// and project detection falls back to git-root / cwd (src/library/projects.ts).
//
// Wiring note (see docs/prds/phases/layer-0-foundation.md §11.7): this is a
// library function, not a standalone CLI binary. `node --experimental-strip-types`
// cannot run this repo's src/ on Node 24 (the same limitation already on
// record for `pnpm db:migrate`), so a `package.json` `bin` entry that shells
// out to TS source directly would be broken on arrival. runInit() + its
// tests are the deliverable; a real `bin/iranti` (compiled dist/ entry, or a
// tsx-shimmed script) is deferred to the cutover/publish step, where the
// build pipeline is being decided anyway.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HostConfig } from "./projects.js";

export interface RunInitOptions {
  // The Projects root to pin — every subfolder underneath becomes its own
  // project (unless it has its own git root, which takes precedence).
  projectsRoot?: string;
  // Where the embedded PGlite store should live. Defaults to leaving
  // whatever is already configured (or connection.ts's own ~/.iranti/db
  // default) untouched if omitted.
  dataDir?: string;
  // Injectable for tests — defaults to the real home directory / real fs.
  homeDir?: string;
}

export interface RunInitResult {
  configPath: string;
  config: HostConfig;
  created: boolean; // true if this call created the file for the first time
}

function configPathFor(homeDir: string): string {
  return path.join(homeDir, ".iranti", "config.json");
}

async function readExistingConfig(configPath: string): Promise<HostConfig | undefined> {
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        projectsRoot: typeof obj["projectsRoot"] === "string" ? obj["projectsRoot"] : undefined,
        dataDir: typeof obj["dataDir"] === "string" ? obj["dataDir"] : undefined,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Write/update the host config. Merges with whatever is already there —
// calling runInit({ projectsRoot }) alone does not clobber a previously
// configured dataDir, and vice versa. Idempotent: running it twice with the
// same options produces the same file.
export async function runInit(options: RunInitOptions = {}): Promise<RunInitResult> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = configPathFor(homeDir);
  const configDir = path.dirname(configPath);

  const existing = await readExistingConfig(configPath);
  const created = existing === undefined;

  const merged: HostConfig = {
    projectsRoot: options.projectsRoot
      ? path.resolve(options.projectsRoot)
      : existing?.projectsRoot,
    dataDir: options.dataDir ? path.resolve(options.dataDir) : existing?.dataDir,
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  return { configPath, config: merged, created };
}

// Read the current host config without writing anything. Returns an empty
// object if no config exists yet (never throws — a missing config is the
// normal zero-config state, D8).
export async function readInitConfig(homeDir: string = homedir()): Promise<HostConfig> {
  const configPath = configPathFor(homeDir);
  return (await readExistingConfig(configPath)) ?? {};
}
