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
// The extractor is wired into attend's write side (async, off response path).
// It writes extracted facts with source "extractor_heuristic" or
// "extractor_llm" so they are identifiable and bulk-cleanable if needed.

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

// ---------------------------------------------------------------------------
// HeuristicExtractor
// ---------------------------------------------------------------------------

// Decision patterns: we decided to use X, we're going with X, decision: X
const DECISION_PATTERNS: Array<{ re: RegExp; capture: number }> = [
  { re: /\bwe\s+decided\s+to\s+use\s+(.{3,60}?)(?:[.,;]|$)/i, capture: 1 },
  { re: /\bwe\s+chose\s+(.{3,60}?)(?:\s+for|\s+as|[.,;]|$)/i, capture: 1 },
  { re: /\bdecision[:\s]+(.{3,80}?)(?:[.,;]|$)/i, capture: 1 },
  { re: /\bgoing\s+with\s+(.{3,60}?)\s+(?:for|as|because|instead|over)[.,;]?\b/i, capture: 1 },
  { re: /\bwe(?:'re|\ are)\s+(?:using|adopting|switching\s+to)\s+(.{3,60}?)(?:[.,;]|$)/i, capture: 1 },
];

// Preference patterns: I always want X, prefer Y, never use Z
const PREFERENCE_PATTERNS: Array<{ re: RegExp; capture: number; prefix: string }> = [
  { re: /\bi\s+(?:always\s+)?prefer\s+(.{3,60}?)(?:[.,;]|$)/i, capture: 1, prefix: "preference" },
  { re: /\balways\s+(?:use|want|do)\s+(.{3,60}?)(?:[.,;]|$)/i, capture: 1, prefix: "preference" },
  { re: /\bnever\s+(?:use|do)\s+(.{3,60}?)(?:[.,;]|$)/i, capture: 1, prefix: "preference" },
  { re: /\bi\s+(?:want|need)\s+(?:you\s+to\s+)?always\s+(.{3,60}?)(?:[.,;]|$)/i, capture: 1, prefix: "preference" },
];

export class HeuristicExtractor implements ExtractorBackend {
  async extract(message: string): Promise<ExtractedFact[]> {
    const results: ExtractedFact[] = [];
    const seen = new Set<string>();

    for (const { re, capture } of DECISION_PATTERNS) {
      const m = message.match(re);
      if (!m?.[capture]) continue;
      const raw = m[capture].trim().replace(/\s+/g, " ");
      if (raw.length < 3 || raw.length > 120) continue;
      const key = `decision:${slugify(raw)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ key, value: raw, source: "extractor_heuristic", confidence: 0.85 });
    }

    for (const { re, capture, prefix } of PREFERENCE_PATTERNS) {
      const m = message.match(re);
      if (!m?.[capture]) continue;
      const raw = m[capture].trim().replace(/\s+/g, " ");
      if (raw.length < 3 || raw.length > 120) continue;
      const key = `${prefix}:${slugify(raw)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ key, value: raw, source: "extractor_heuristic", confidence: 0.85 });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// LocalLlmExtractor
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = `You extract durable facts from text. Return a JSON array of objects with "key" (kebab-case, prefixed with category like "decision:" or "preference:") and "value" (concise text). Only extract explicit, clearly stated facts — not inferences. Return [] if no clear facts exist. Output valid JSON only, no explanation.`;

export class LocalLlmExtractor implements ExtractorBackend {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(
    endpoint = process.env["IRANTI_LLM_ENDPOINT"] ?? "http://localhost:11434/v1",
    model = process.env["IRANTI_LLM_MODEL"] ?? "qwen2.5:3b",
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  async extract(message: string): Promise<ExtractedFact[]> {
    // Heuristic pass always runs first.
    const heuristic = await new HeuristicExtractor().extract(message);

    // LLM pass: attempt and degrade gracefully.
    let llmFacts: ExtractedFact[] = [];
    try {
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: LLM_SYSTEM_PROMPT },
            { role: "user", content: message.slice(0, 2000) },
          ],
          temperature: 0,
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? "[]";
      const parsed = JSON.parse(content) as Array<{ key?: string; value?: string }>;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item.key === "string" && typeof item.value === "string") {
            llmFacts.push({
              key: item.key.slice(0, 80),
              value: item.value.slice(0, 300),
              source: "extractor_llm",
              confidence: 0.80,
            });
          }
        }
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
    return merged;
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
