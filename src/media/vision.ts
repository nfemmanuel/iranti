// Vision backend — OD-4.
//
// VisionBackend describes media content for keyword retrieval. Local-default
// (Ollama llava/qwen2.5-vl), consistent with OD-2. When vision is off or the
// endpoint is down the NullVisionBackend returns null, and ingestMedia stores
// the object with description_text = null and visionStatus = "failed". The
// object is always safely stored — description is the optional enrichment.
//
// Config:
//   IRANTI_VISION unset / "off"  → NullVisionBackend (default)
//   IRANTI_VISION="local"        → LocalLlmVisionBackend (Ollama)
//   IRANTI_VISION_MODEL          → model name (default: "llava")
//   IRANTI_LLM_ENDPOINT          → reuses the extractor endpoint

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface VisionResult {
  description: string;
  tags: string[];
}

export interface VisionBackend {
  /** Returns null when vision is unavailable or the model fails. Never throws. */
  describe(bytes: Buffer, mime: string): Promise<VisionResult | null>;
}

// ---------------------------------------------------------------------------
// NullVisionBackend — always-available fallback
// ---------------------------------------------------------------------------

export class NullVisionBackend implements VisionBackend {
  async describe(_bytes: Buffer, _mime: string): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LocalLlmVisionBackend — Ollama (llava / qwen2.5-vl)
// ---------------------------------------------------------------------------

const VISION_SYSTEM_PROMPT =
  "Describe this image in one or two concise sentences suitable for memory retrieval. " +
  "Then list 3-7 keyword tags. Respond in JSON: " +
  '{"description": "...", "tags": ["tag1", "tag2"]}. ' +
  "Output valid JSON only.";

export class LocalLlmVisionBackend implements VisionBackend {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(
    endpoint = process.env["IRANTI_LLM_ENDPOINT"] ?? "http://localhost:11434/v1",
    model = process.env["IRANTI_VISION_MODEL"] ?? "llava",
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  async describe(bytes: Buffer, mime: string): Promise<VisionResult | null> {
    // Ollama's vision models accept base64 image_url content parts.
    if (!mime.startsWith("image/")) return null;

    const base64 = bytes.toString("base64");
    const dataUrl = `data:${mime};base64,${base64}`;

    try {
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_SYSTEM_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 256,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) return null;

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as { description?: string; tags?: unknown };

      const description = typeof parsed.description === "string" ? parsed.description.slice(0, 500) : "";
      const tags = Array.isArray(parsed.tags)
        ? (parsed.tags as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 20)
        : [];

      if (!description) return null;
      return { description, tags };
    } catch {
      // Endpoint down, timeout, parse error — degrade gracefully.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton — selected by IRANTI_VISION env var
// ---------------------------------------------------------------------------

function buildVision(): VisionBackend {
  const mode = process.env["IRANTI_VISION"] ?? "off";
  if (mode === "local") return new LocalLlmVisionBackend();
  return new NullVisionBackend();
}

export const vision: VisionBackend = buildVision();
