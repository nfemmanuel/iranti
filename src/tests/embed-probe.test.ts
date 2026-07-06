// Unit tests — CORE-17 S4: embedder auto-ON-when-reachable probe.
//
// The ratified §9 decision (docs/prds/phases/core-17-retrieval-first-recall.md):
// "recall embedder default = ON when an embedder is reachable (endpoint up AND
// embed model present via probe), else silent OFF." This pins that the probe is
// BOUNDED (short timeout, no latency penalty on the default path), MEMOIZED
// (probed at most once per process), and FAIL-CLOSED (unreachable / error /
// timeout ⇒ "off", never throws) — and that an explicit IRANTI_EMBEDDER=off
// ALWAYS wins over the probe (the user's opt-out is honored).
//
// No live Ollama: fetch is stubbed per-case (vi.stubGlobal), exactly the shape
// src/harness/semantic-bench.test.ts:40's embedderReachable() probes — a POST
// to /api/embed that returns a non-empty embeddings array proves the model is
// present, and any other outcome is treated as unreachable. Deterministic in CI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEmbedderMode,
  resetEmbedderCache,
} from "../embed/index.js";
import { ensureEmbedderProbe, resetEmbedderProbe } from "../embed/probe.js";

// A fetch stub that resolves as a reachable Ollama /api/embed (returns a real
// embedding vector — the "model present" proof) and counts its invocations, so
// the memoization assertion can check the probe ran at most once.
function reachableFetch(): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const stub = (() => {
    calls++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ embeddings: [[0.1, 0.2, 0.3]] }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetch: stub, calls: () => calls };
}

// A fetch stub that simulates an unreachable endpoint: rejects like a refused
// connection. The probe must swallow this and resolve "off", not throw.
function unreachableFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const stub = (() => {
    calls++;
    return Promise.reject(new Error("ECONNREFUSED 127.0.0.1:11434"));
  }) as unknown as typeof fetch;
  return { fetch: stub, calls: () => calls };
}

describe("CORE-17 S4 — embedder auto-ON-when-reachable probe", () => {
  const savedEmbedder = process.env["IRANTI_EMBEDDER"];

  beforeEach(() => {
    // Each case starts from a clean slate: probe un-run, singleton cache cleared,
    // env unset (the "auto" case). Individual tests set IRANTI_EMBEDDER as needed.
    delete process.env["IRANTI_EMBEDDER"];
    resetEmbedderProbe();
    resetEmbedderCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEmbedderProbe();
    resetEmbedderCache();
    if (savedEmbedder === undefined) delete process.env["IRANTI_EMBEDDER"];
    else process.env["IRANTI_EMBEDDER"] = savedEmbedder;
  });

  it("UNSET + probe-unreachable ⇒ off, fast and without throwing", async () => {
    const { fetch: stub } = unreachableFetch();
    vi.stubGlobal("fetch", stub);

    const start = Date.now();
    // Must not throw even though the underlying fetch rejects (fail-closed).
    await expect(ensureEmbedderProbe()).resolves.toBe(false);
    const elapsed = Date.now() - start;

    expect(getEmbedderMode()).toBe("off");
    // Fail-closed path returns essentially instantly on a refused connection —
    // well under the bounded timeout; assert it did not hang.
    expect(elapsed).toBeLessThan(1500);
  });

  it("UNSET + probe-reachable ⇒ ollama", async () => {
    const { fetch: stub } = reachableFetch();
    vi.stubGlobal("fetch", stub);

    await expect(ensureEmbedderProbe()).resolves.toBe(true);

    expect(getEmbedderMode()).toBe("ollama");
  });

  it("explicit IRANTI_EMBEDDER=off ⇒ off even when the endpoint IS reachable (opt-out wins)", async () => {
    const { fetch: stub, calls } = reachableFetch();
    vi.stubGlobal("fetch", stub);
    process.env["IRANTI_EMBEDDER"] = "off";

    // The probe must be skipped entirely for an explicit opt-out — no network.
    await expect(ensureEmbedderProbe()).resolves.toBe(false);

    expect(getEmbedderMode()).toBe("off");
    expect(calls()).toBe(0);
  });

  it("explicit IRANTI_EMBEDDER=ollama ⇒ ollama without probing (explicit wins, unchanged behavior)", async () => {
    const { fetch: stub, calls } = unreachableFetch();
    vi.stubGlobal("fetch", stub);
    process.env["IRANTI_EMBEDDER"] = "ollama";

    // Explicit opt-IN also skips the probe: the mode is whatever the user set,
    // exactly as today. (A dead endpoint then degrades inside OllamaEmbedder.)
    await ensureEmbedderProbe();

    expect(getEmbedderMode()).toBe("ollama");
    expect(calls()).toBe(0);
  });

  it("explicit IRANTI_EMBEDDER=mock ⇒ mock, unchanged (test backend, no probe)", async () => {
    const { fetch: stub, calls } = reachableFetch();
    vi.stubGlobal("fetch", stub);
    process.env["IRANTI_EMBEDDER"] = "mock";

    await ensureEmbedderProbe();

    expect(getEmbedderMode()).toBe("mock");
    expect(calls()).toBe(0);
  });

  it("probe is memoized — the network probe runs at most once across repeated calls", async () => {
    const { fetch: stub, calls } = reachableFetch();
    vi.stubGlobal("fetch", stub);

    await ensureEmbedderProbe();
    await ensureEmbedderProbe();
    await ensureEmbedderProbe();
    // getEmbedderMode() itself must never re-probe — it only reads the verdict.
    getEmbedderMode();
    getEmbedderMode();

    expect(calls()).toBe(1);
    expect(getEmbedderMode()).toBe("ollama");
  });

  it("concurrent first-probe callers share ONE in-flight probe (no thundering herd)", async () => {
    const { fetch: stub, calls } = reachableFetch();
    vi.stubGlobal("fetch", stub);

    // Fire several probes before the first resolves — they must coalesce.
    await Promise.all([
      ensureEmbedderProbe(),
      ensureEmbedderProbe(),
      ensureEmbedderProbe(),
    ]);

    expect(calls()).toBe(1);
  });

  it("a reachable endpoint that returns an EMPTY embeddings array ⇒ off (model not usable)", async () => {
    // Endpoint up (200 OK) but the embed produced no vector — treat as not
    // present/usable, degrade to off. Mirrors embedderReachable()'s non-empty
    // check at semantic-bench.test.ts:51.
    const stub = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ embeddings: [] }),
      } as unknown as Response)) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stub);

    await expect(ensureEmbedderProbe()).resolves.toBe(false);
    expect(getEmbedderMode()).toBe("off");
  });

  it("a non-OK HTTP status (e.g. 500) ⇒ off (fail-closed, no throw)", async () => {
    const stub = (() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as unknown as Response)) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stub);

    await expect(ensureEmbedderProbe()).resolves.toBe(false);
    expect(getEmbedderMode()).toBe("off");
  });

  it("BEFORE the probe resolves, getEmbedderMode() is off (fail-closed default, sync hot path stays safe)", () => {
    // No ensureEmbedderProbe() awaited here: the synchronous hot-path callers
    // (isEmbedderActive() in attend/chunks/facts/write-hook) must see "off"
    // until the probe has proven reachability — never a hang, never a throw.
    const { fetch: stub } = reachableFetch();
    vi.stubGlobal("fetch", stub);
    expect(getEmbedderMode()).toBe("off");
  });
});
