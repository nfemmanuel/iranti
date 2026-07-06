// Embedder reachability probe — CORE-17 S4 (auto-ON-when-reachable).
//
// The ratified §9 decision (docs/prds/phases/core-17-retrieval-first-recall.md,
// re-ratified with OD-2's local-Ollama-default): the recall embedder defaults
// ON when an embedder is reachable, else silent OFF. "Reachable" = the Ollama
// endpoint is up AND the configured embed model is present/usable. This module
// owns that probe.
//
// Three properties the decision demands, and why:
//   - BOUNDED: a short AbortSignal timeout so a machine WITHOUT Ollama (or with
//     a hung port) degrades to today's zero-infra behavior instantly, never
//     hanging the server. A refused connection returns essentially immediately;
//     the timeout only caps the pathological "port open but unresponsive" case.
//   - MEMOIZED: at most ONE probe per process. The verdict is cached and every
//     subsequent read is free — the synchronous hot path (isEmbedderActive() in
//     attend/chunks/facts/write-hook) must never pay a network cost.
//   - FAIL-CLOSED: any error, timeout, non-OK status, or empty embedding ⇒ the
//     verdict is `false` (→ "off"). The probe NEVER throws; unreachable is a
//     valid, expected outcome (mirrors OllamaEmbedder's degrade-to-empty posture
//     in ./ollama.ts and the isEmbedderActive() short-circuit in ./index.ts).
//
// The probe SHAPE mirrors the proven embedderReachable() at
// src/harness/semantic-bench.test.ts:40 and OllamaEmbedder.embed at
// ./ollama.ts:40 — a POST to /api/embed with the configured model. A non-empty
// embeddings array is the strongest "model present" signal available: it proves
// the endpoint is up AND the model actually loads and produces a vector (a
// stronger check than /api/tags, which can list a model that fails to load).

const DEFAULT_ENDPOINT = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";

// Short + bounded: on the default (no-Ollama) install a refused connection is
// near-instant; this cap only guards the "open but unresponsive" pathology so
// server startup is never delayed more than ~1.5s worst case. Kept well below
// the 15s embed timeout in ollama.ts — this is a startup liveness probe, not a
// working embed call, so it must be quick.
const PROBE_TIMEOUT_MS = 1500;

// Memoized verdict + in-flight promise. `verdict` is the resolved boolean once
// the probe has completed; `inFlight` coalesces concurrent first-probe callers
// so several parallel ensureEmbedderProbe() calls trigger exactly one network
// probe (no thundering herd at startup).
let verdict: boolean | undefined;
let inFlight: Promise<boolean> | undefined;

// The synchronous verdict the mode resolver reads. Returns `false` (fail-closed)
// until the probe has completed AND come back reachable — so getEmbedderMode()
// stays a cheap sync function and the hot path is byte-identical to today until
// reachability is proven. Never triggers a probe itself.
export function embedderProbeVerdict(): boolean {
  return verdict === true;
}

// Runs the bounded reachability probe ONCE per process and memoizes the result.
// Safe to call repeatedly and concurrently — later calls return the cached
// verdict (or join the in-flight probe). Awaited at server startup so real
// installs light up the recall tier; awaited in tests so the verdict is
// observable to the synchronous getEmbedderMode().
//
// Short-circuits when IRANTI_EMBEDDER is set EXPLICITLY: the probe exists only
// to resolve the UNSET (default-install) case. If the user opted out (off) or
// opted in (ollama/mock), that decision is honored verbatim and NO network
// probe fires — the verdict stays fail-closed `false` (getEmbedderMode() reads
// the explicit env directly and never consults the verdict in those cases).
export async function ensureEmbedderProbe(): Promise<boolean> {
  if (verdict !== undefined) return verdict;
  if (inFlight) return inFlight;
  const explicit = process.env["IRANTI_EMBEDDER"];
  if (explicit === "off" || explicit === "ollama" || explicit === "mock") {
    verdict = false;
    return verdict;
  }
  inFlight = runProbe()
    .then((reachable) => {
      verdict = reachable;
      return reachable;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function runProbe(): Promise<boolean> {
  const endpoint = (process.env["IRANTI_EMBED_ENDPOINT"] ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const model = process.env["IRANTI_EMBED_MODEL"] ?? DEFAULT_MODEL;
  try {
    const res = await fetch(`${endpoint}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: ["ping"] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { embeddings?: unknown };
    // Model present + usable iff a real, non-empty embedding came back.
    return (
      Array.isArray(json.embeddings) &&
      json.embeddings.length > 0 &&
      Array.isArray(json.embeddings[0]) &&
      (json.embeddings[0] as unknown[]).length > 0
    );
  } catch {
    // Unreachable / timeout / DNS / refused / malformed — all fail-closed.
    return false;
  }
}

// Test-only escape hatch: clear the memoized verdict + in-flight probe so a
// test can re-drive the probe under a different fetch stub. Production code
// never calls this (the process-lifetime memo is the point).
export function resetEmbedderProbe(): void {
  verdict = undefined;
  inFlight = undefined;
}
