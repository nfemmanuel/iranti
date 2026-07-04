// Semantic extraction — Phase 2b
//
// Extracts atomic durable facts from unstructured message text. Two
// implementations:
//
//   HeuristicExtractor — always-on, deterministic, zero cost. Matches
//   explicit decision/preference markers ("we decided to use X",
//   "I always want Y"). Tuned for precision over recall: a missed fact
//   is far cheaper than a wrong fact stored in memory.
//
//   LocalLlmExtractor — optional, async, config-gated. Calls any
//   OpenAI-compatible endpoint (Ollama default). Degrades gracefully to
//   empty results if the endpoint is unreachable, so it never adds
//   latency to the response path.
//
// Selected by IRANTI_EXTRACTOR env var:
//   heuristic (default) — HeuristicExtractor only
//   local               — HeuristicExtractor + LocalLlmExtractor
//
// IRANTI_LLM_ENDPOINT / IRANTI_LLM_MODEL point LocalLlmExtractor at any
// OpenAI-compatible endpoint (Ollama by default, but also a frontier
// provider's compatibility endpoint). IRANTI_LLM_API_KEY, when set, is sent
// on that request (see buildHeaders below) — this is what lets the "local"
// mode reach an authenticated endpoint (Anthropic, NVIDIA NIM) instead of
// only an open local one.
//
// AX-2: LocalLlmExtractor is wrapped by an extraction cache (durable,
// content-hash keyed). Repeat extractions of the same input under the same
// regime return cached facts with zero LLM calls. Cache misses fall through
// to normal extraction; cache errors degrade silently to plain extraction.
//
// The extractor is wired into attend's write side (async, off response path).
// It writes extracted facts with source "extractor_heuristic" or
// "extractor_llm" so they are identifiable and bulk-cleanable if needed.

import { normalizeKey, NORMALIZER_VERSION } from "../library/keys.js";
import {
  hashInput,
  buildRegimeSignature,
  readCache,
  writeCache,
} from "../library/extraction-cache.js";
import { parseLlmJson } from "../library/llm-json.js";
import { trackBackground } from "../library/background.js";

// AX-2: bump this whenever LLM_SYSTEM_PROMPT or output-affecting decode params
// change. A version change guarantees cache misses across all tenants so stale
// facts extracted under the old prompt are never re-served.
// IMPORTANT: changing LLM_SYSTEM_PROMPT requires a corresponding bump here.
export const EXTRACTION_PROMPT_VERSION = "1";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ExtractedFact {
  key: string;   // kebab-case with category prefix: "decision:use-x", "preference:always-y"
  value: string; // concise statement of the fact
  source: string; // "extractor_heuristic" | "extractor_llm"
  confidence: number; // 0.0–1.0; heuristic = 0.85, LLM = 0.80
}

export interface ExtractorBackend {
  extract(message: string): Promise<ExtractedFact[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

// Most signal classes share the same shape: match a regex, take one capture
// group as the fact value, prefix the key by category. This runs that pattern
// so each category is one call instead of a copy-pasted loop. `seen` dedups
// keys across categories; matches are appended to `out` in call order.
type SingleCapturePattern = { re: RegExp; capture: number };

function extractSingleCapture(
  message: string,
  patterns: SingleCapturePattern[],
  keyPrefix: string,
  confidence: number,
  seen: Set<string>,
  out: ExtractedFact[],
): void {
  for (const { re, capture } of patterns) {
    const m = message.match(re);
    if (!m?.[capture]) continue;
    const raw = m[capture].trim().replace(/\s+/g, " ");
    if (raw.length < 3 || raw.length > 120) continue;
    const key = `${keyPrefix}:${slugify(raw)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value: raw, source: "extractor_heuristic", confidence });
  }
}

// ---------------------------------------------------------------------------
// HeuristicExtractor
// ---------------------------------------------------------------------------

// AX-9: the clause-terminator class. Em-dash, en-dash, and the SPACED hyphen
// join [.,;] — real prose delimits clauses with dashes exactly like commas,
// and without them a dash-punctuated sentence pushes the lazy capture past
// its length cap and extracts NOTHING (the dogfood eval's two live misses,
// check 2). Unspaced hyphens are deliberately NOT terminators: they appear
// inside identifiers (dogfood/report-1, feature-store) that must survive
// inside a captured value.
const T = String.raw`(?:[.,;—–]|\s-\s|$)`;

// Decision patterns: we decided to use X, we're going with X, "Decision: X"
// (sentence-initial label only — see the AX-9 note below).
const DECISION_PATTERNS: Array<{ re: RegExp; capture: number }> = [
  { re: new RegExp(String.raw`\bwe\s+decided\s+to\s+use\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bwe\s+chose\s+(.{3,60}?)(?:\s+for|\s+as|[.,;—–]|\s-\s|$)`, "i"), capture: 1 },
  // AX-9: this was /\bdecision[:\s]+…/ — a bare noun match that fired on the
  // word "decision" ANYWHERE, colon or no colon, including under negation
  // ("Told the user no rate limiting decision is on record…" → stored a
  // fact asserting the OPPOSITE; the live dogfood fabrication, check 3).
  // Now a sentence-initial LABEL: colon required, label must open a
  // sentence — the shape every real corpus positive already uses
  // ("Decision: all new components live under…"). A negation lookbehind was
  // rejected: negators sit arbitrarily far before the noun, and
  // enumerate-the-negators is a losing game. Precision over recall.
  { re: new RegExp(String.raw`(?:^|[.!?]\s+)decision:\s+(.{3,80}?)` + T, "im"), capture: 1 },
  { re: /\bgoing\s+with\s+(.{3,60}?)\s+(?:for|as|because|instead|over)[.,;]?\b/i, capture: 1 },
  { re: new RegExp(String.raw`\bwe(?:'re| are)\s+(?:using|adopting|switching\s+to)\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\blet'?s\s+(?:use|go\s+with)\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bwe\s+(?:decided|agreed|concluded)\s+(?:that\s+)?(.{3,80}?)` + T, "i"), capture: 1 },
];

// Preference patterns: I always want X, prefer Y, never use Z
const PREFERENCE_PATTERNS: SingleCapturePattern[] = [
  { re: new RegExp(String.raw`\bi\s+(?:always\s+)?prefer\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\balways\s+(?:use|want|do)\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bnever\s+(?:use|do)\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bi\s+(?:want|need)\s+(?:you\s+to\s+)?always\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bplease\s+(?:always\s+)?(.{3,60}?)(?:\s+when|\s+if|[.,;—–]|\s-\s|$)`, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bmake\s+sure\s+(?:to\s+)?(?:always\s+)?(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bi\s+(?:don'?t|do\s+not)\s+(?:want|like)\s+(.{3,60}?)` + T, "i"), capture: 1 },
];

// Constraint patterns: we can't use X, "Constraint:/Requirement: X" (labels,
// sentence-initial only — same AX-9 rationale as DECISION_PATTERNS above:
// the bare-noun forms fabricated from negated sentences), must not do Y.
const CONSTRAINT_PATTERNS: Array<{ re: RegExp; capture: number }> = [
  { re: new RegExp(String.raw`\bwe\s+(?:can'?t|cannot|must\s+not|should\s+not|won'?t)\s+use\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`(?:^|[.!?]\s+)requirement:\s+(.{3,80}?)` + T, "im"), capture: 1 },
  { re: new RegExp(String.raw`(?:^|[.!?]\s+)constraint:\s+(.{3,80}?)` + T, "im"), capture: 1 },
  { re: new RegExp(String.raw`\bwe\s+(?:have\s+to|must)\s+(.{3,60}?)` + T, "i"), capture: 1 },
  { re: new RegExp(String.raw`\bnot\s+allowed\s+to\s+(.{3,60}?)` + T, "i"), capture: 1 },
];

// Failed approach patterns: tried X but failed, X didn't work
const FAILED_PATTERNS: Array<{ re: RegExp; capture: number }> = [
  { re: /\b(?:we\s+)?tried\s+(.{3,60}?)\s+(?:but|and)\s+(?:it\s+)?(?:didn'?t\s+work|failed|was\s+wrong)/i, capture: 1 },
  { re: /\b(.{3,60}?)\s+didn'?t\s+work(?:\s+because|\s+for)?/i, capture: 1 },
  { re: /\b(?:don'?t|do\s+not)\s+(?:use|try)\s+(.{3,60}?)\s+(?:—|for|because|it|if)/i, capture: 1 },
  { re: new RegExp(String.raw`\bfailed\s+approach[:\s]+(.{3,80}?)` + T, "i"), capture: 1 },
];

// Correction patterns: actually X is Y, the correct value is Y
const CORRECTION_PATTERNS: Array<{ re: RegExp; capture: string }> = [
  { re: new RegExp(String.raw`\bactually,?\s+(.{3,60}?)\s+(?:is|should\s+be)\s+(.{3,60}?)` + T, "i"), capture: "1:2" },
  { re: new RegExp(String.raw`\bthe\s+correct\s+(?:value\s+(?:for\s+)?(?:of\s+)?)?(.{3,60}?)\s+is\s+(.{3,60}?)` + T, "i"), capture: "1:2" },
];

export class HeuristicExtractor implements ExtractorBackend {
  // Synchronous work wrapped in a resolved promise to satisfy the async
  // ExtractorBackend contract without a needless `async` (no await inside).
  extract(message: string): Promise<ExtractedFact[]> {
    const results: ExtractedFact[] = [];
    const seen = new Set<string>();

    extractSingleCapture(message, DECISION_PATTERNS, "decision", 0.85, seen, results);
    extractSingleCapture(message, PREFERENCE_PATTERNS, "preference", 0.85, seen, results);
    extractSingleCapture(message, CONSTRAINT_PATTERNS, "constraint", 0.85, seen, results);
    extractSingleCapture(message, FAILED_PATTERNS, "failed-approach", 0.80, seen, results);

    // Correction patterns are two-capture ("subject is value") — kept bespoke.
    for (const { re, capture } of CORRECTION_PATTERNS) {
      const m = message.match(re);
      if (!m) continue;
      // capture is "1:2" — combine both groups into "subject is value"
      const [c1, c2] = capture.split(":");
      const subject = m[Number(c1)]?.trim().replace(/\s+/g, " ") ?? "";
      const val = m[Number(c2)]?.trim().replace(/\s+/g, " ") ?? "";
      if (subject.length < 3 || val.length < 2) continue;
      const combined = `${subject} is ${val}`;
      const key = `correction:${slugify(subject)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ key, value: combined, source: "extractor_heuristic", confidence: 0.85 });
    }

    return Promise.resolve(results);
  }
}

// ---------------------------------------------------------------------------
// LocalLlmExtractor
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = `You extract durable facts from text. Return a JSON array of objects with "key" (kebab-case, prefixed with category like "decision:" or "preference:") and "value" (concise text). Only extract explicit, clearly stated facts — not inferences. Return [] if no clear facts exist. Output valid JSON only, no explanation.`;

// extraction-measurement.md §3 (change 2) — optional auth headers.
//
// LocalLlmExtractor's fetch previously sent no Authorization/x-api-key
// header at all, so the R2 measurement regime (frontier LLM via Anthropic's
// OpenAI-compatible endpoint, or NVIDIA NIM) could never authenticate
// regardless of endpoint config. IRANTI_LLM_API_KEY, when set, is sent as
// BOTH `Authorization: Bearer <key>` and `x-api-key: <key>` — the union of
// what OpenAI-compatible providers (bearer) and Anthropic's native header
// style (x-api-key) expect; an endpoint that only recognizes one of the two
// simply ignores the other, so this is harmless when either is unused.
// `anthropic-version` is added ONLY when the endpoint host contains
// "anthropic.com", since that header is meaningless (and NIM/Ollama would
// have no opinion on it either way, but there's no reason to send a
// provider-specific header to a provider that isn't that provider).
//
// Pulled out as its own pure function (endpoint + key in, headers out —
// no fetch, no env access) so header assembly has a direct unit test
// without needing a real or mocked network call.
//
// SECURITY NOTE (verified, see also buildRegimeSignature in
// library/extraction-cache.ts): the key is never logged (no caller passes
// it to console.error/console.log anywhere in this module) and never enters
// the extraction-cache's regime signature. buildRegimeSignature's inputs
// are extractorMode/modelId/promptVersion/normalizerVersion only — the key
// is deliberately NOT a parameter there, so cache keys stay stable across
// key rotation and no key material ever reaches the cache's plaintext
// signature column.
export function buildHeaders(endpoint: string, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!apiKey) return headers;

  headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-api-key"] = apiKey;

  if (endpoint.includes("anthropic.com")) {
    headers["anthropic-version"] = "2023-06-01";
  }

  return headers;
}

// messy-corpus build — found live running R1 (local qwen2.5:7b) against the
// messy corpus: the hardcoded 8000ms request timeout below was silently
// truncating EVERY LLM call on this hardware (a corpus-realistic message
// measured 47.5s to complete against the real Ollama endpoint — see the
// commit this constant ships with for the reproduction), so every call hit
// the catch block, degraded to llmFacts = [], and R1 was byte-identical to
// R0 — a second null-by-construction artifact, this time from a timeout
// rather than the scorer's key-identity credit (the problem this whole build
// exists to fix at the scoring layer). Default UNCHANGED (still 8000) so
// production/CI behavior is byte-identical unless this var is explicitly
// set — this is an escape hatch for slow local models during measurement,
// not a production timeout change.
const DEFAULT_LLM_TIMEOUT_MS = 8000;

function resolveTimeoutMs(): number {
  const raw = process.env["IRANTI_LLM_TIMEOUT_MS"];
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LLM_TIMEOUT_MS;
}

export class LocalLlmExtractor implements ExtractorBackend {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    endpoint = process.env["IRANTI_LLM_ENDPOINT"] ?? "http://localhost:11434/v1",
    model = process.env["IRANTI_LLM_MODEL"] ?? "qwen2.5:3b",
    timeoutMs = resolveTimeoutMs(),
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async extract(message: string): Promise<ExtractedFact[]> {
    // AX-2: check cache before calling the LLM.
    const inputHash = hashInput(message);
    const regimeSig = buildRegimeSignature(
      "local",
      this.model,
      EXTRACTION_PROMPT_VERSION,
      NORMALIZER_VERSION,
    );

    try {
      const cached = await readCache(inputHash, regimeSig);
      if (cached !== null) return cached;
    } catch (err) {
      // Cache read error — degrade to plain extraction, never block.
      console.error("[iranti] extraction-cache read error:", err);
    }

    const { facts: merged, llmSucceeded } = await this._extractFresh(message);

    // Only cache when the LLM pass actually ran — a transient outage degrades
    // _extractFresh to heuristic-only; caching that thin result would poison
    // every future cache hit for the same input once the LLM recovers.
    if (llmSucceeded) {
      // Tracked (RULE-2 audit): detached DB write must be visible to
      // teardown's settleBackground — see background.ts.
      trackBackground(
        writeCache(
          inputHash,
          regimeSig,
          "local",
          this.model,
          EXTRACTION_PROMPT_VERSION,
          NORMALIZER_VERSION,
          merged,
        ).catch((err: unknown) =>
          console.error("[iranti] extraction-cache write error:", err),
        ),
      );
    }

    return merged;
  }

  private async _extractFresh(message: string): Promise<{ facts: ExtractedFact[]; llmSucceeded: boolean }> {
    // Heuristic pass always runs first.
    const heuristic = await new HeuristicExtractor().extract(message);

    // LLM pass: attempt and degrade gracefully.
    let llmFacts: ExtractedFact[] = [];
    let llmSucceeded = false;
    try {
      // messy-corpus build — found live running R2 (frontier claude-sonnet-5
      // via Anthropic's OpenAI-compat endpoint): unconditionally sending
      // `temperature: 0` was rejected with HTTP 400 "`temperature` is
      // deprecated for this model" — confirmed by a direct curl reproduction
      // (same request minus `temperature` returns 200 with a correct
      // extraction). This is a model-side API constraint on this specific
      // endpoint/model pairing, not an auth or endpoint-reachability problem
      // — the same request succeeds instantly once the parameter is omitted.
      // Gated the SAME way `anthropic-version` already is just above
      // (buildHeaders) — anthropic.com hosts omit temperature entirely
      // (falls back to that model's own default, since 0 isn't accepted
      // there); every other host (Ollama, NIM) is BYTE-IDENTICAL to before,
      // still gets temperature: 0 for deterministic decoding.
      const isAnthropicHost = this.endpoint.includes("anthropic.com");
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: "system", content: LLM_SYSTEM_PROMPT },
          { role: "user", content: message.slice(0, 2000) },
        ],
        max_tokens: 512,
      };
      if (!isAnthropicHost) {
        body["temperature"] = 0;
      }

      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(this.endpoint, process.env["IRANTI_LLM_API_KEY"]),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? "[]";
      const parsed = parseLlmJson<Array<{ key?: string; value?: string }>>(content);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item.key === "string" && typeof item.value === "string") {
            // Pre-slice to bound regex work; normalizeKey caps the result at 80.
            const key = normalizeKey(item.key.slice(0, 200));
            // Skip a key that normalizes to empty (punctuation-only) — writeFact
            // would reject it anyway, and it must never reach the merge/dedup set.
            if (!key) continue;
            llmFacts.push({
              key,
              value: item.value.slice(0, 300),
              source: "extractor_llm",
              confidence: 0.80,
            });
          }
        }
        llmSucceeded = true;
      }
    } catch {
      // Endpoint unreachable, timeout, JSON parse error — degrade to heuristic only.
      llmFacts = [];
    }

    // Merge: heuristic facts take precedence (dedupe by key).
    const seen = new Set(heuristic.map((f) => f.key));
    const merged = [...heuristic];
    for (const f of llmFacts) {
      if (!seen.has(f.key)) {
        seen.add(f.key);
        merged.push(f);
      }
    }
    return { facts: merged, llmSucceeded };
  }
}

// ---------------------------------------------------------------------------
// Singleton — selected by IRANTI_EXTRACTOR env var
// ---------------------------------------------------------------------------

function buildExtractor(): ExtractorBackend {
  const mode = process.env["IRANTI_EXTRACTOR"] ?? "heuristic";
  if (mode === "local") return new LocalLlmExtractor();
  return new HeuristicExtractor();
}

export const extractor: ExtractorBackend = buildExtractor();
