// Regime signature — CORE-16 (D4), mirrors AX-2's buildRegimeSignature
// (src/library/extraction-cache.ts) for the same reason: a stored artifact
// (there, a cached extraction; here, a fact's embedding) is only valid under
// the exact regime that produced it. Model swap ⇒ old vectors invisible ⇒
// no cross-model cosine (mathematically meaningless) and no silent drift.
// Re-embedding is lazy: a fact whose regime doesn't match the active
// embedder's is treated as absent, and gets re-embedded next write/backfill.

import type { EmbedderIdentity } from "./index.js";

export interface EmbedRegime {
  model: string;
  dim: number;
  v: string; // version, matches EmbedderIdentity.version
}

// Bump whenever the embed-text composition changes (D6: `key + ": " + value`
// today) — a different input text under the same model would silently
// produce vectors that aren't comparable to ones embedded under the old
// composition, exactly like AX-2's promptVersion/normalizerVersion inputs.
export const EMBED_TEXT_VERSION = "1";

export function buildEmbedRegime(identity: EmbedderIdentity): EmbedRegime {
  return {
    model: identity.model,
    dim: identity.dim,
    v: `${identity.version}|${EMBED_TEXT_VERSION}`,
  };
}

// True when a fact's stored regime matches the currently-active embedder's
// regime. A missing/malformed stored regime (pre-CORE-16 facts, or a fact
// embedded before this shape existed) is always a mismatch — the safe
// default is "treat as absent, re-embed lazily," never "assume valid."
export function regimeMatches(
  stored: unknown,
  active: EmbedRegime,
): boolean {
  if (stored == null || typeof stored !== "object") return false;
  const s = stored as Record<string, unknown>;
  return s["model"] === active.model && s["dim"] === active.dim && s["v"] === active.v;
}

// D6: compose the embed text for a fact. Key carries the categorical signal,
// value the content. Clamped so a pathologically long value doesn't blow an
// embedder's input-token budget; measured against alternatives only if the
// corpus shows a problem (no speculative tuning per the PRD).
const EMBED_TEXT_MAX_LEN = 2000;
export function composeEmbedText(key: string, value: string): string {
  const text = `${key}: ${value}`;
  return text.length > EMBED_TEXT_MAX_LEN ? text.slice(0, EMBED_TEXT_MAX_LEN) : text;
}
