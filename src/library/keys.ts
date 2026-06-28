// Key normalization — AX-1.
//
// normalizeKey is the single shared function applied at every write, read,
// and extraction boundary so the same concept always lands on the same
// (entity, key) slot regardless of spelling, case, or separator.
//
// Layer 1 (always-on, syntactic — this file):
//   1. Split optional `category:` prefix on the first colon.
//   2. camelCase → hyphen boundaries (two regex passes).
//   3. Lowercase.
//   4. Collapse runs of non-alphanumeric characters to a single `-`.
//   5. Trim leading/trailing `-`.
//   6. Reattach `category:slug`.
//   7. Cap at MAX_KEY_LENGTH chars (drop a trailing `-` left by the cut).
//
// Layer 2 (synonym/alias map, opt-in, versioned — not in this file):
//   Deferred. Table `key_aliases` + seeding land when the first real
//   synonym pair is needed. See: docs/prds/phases/ax-1-key-normalization.md
//
// Guarantee: normalizeKey(normalizeKey(x)) === normalizeKey(x)
//
// AX-2: bump NORMALIZER_VERSION whenever the normalizeKey algorithm changes
// semantics — this is part of the extraction cache regime signature, so a
// version bump guarantees cache busting across all tenants.
export const NORMALIZER_VERSION = "1";

// Upper bound on a stored key. Applied INSIDE normalizeKey so the write side,
// the read side, and both extractors agree on the same capped key — otherwise a
// long key written capped would never be found by an un-capped read (and the
// heuristic extractor's 40-char slugs would never collapse with longer LLM keys).
const MAX_KEY_LENGTH = 80;

function capLength(key: string): string {
  if (key.length <= MAX_KEY_LENGTH) return key;
  // Drop any trailing hyphen the cut leaves behind so the result stays
  // canonical (no dangling `-`) and idempotent under re-normalization.
  return key.slice(0, MAX_KEY_LENGTH).replace(/-+$/, "");
}

function normalizeSegment(s: string): string {
  return (
    s
      // camelCase: lowercase/digit → uppercase boundary  (researchFocus → research-Focus)
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      // camelCase: acronym → title-case boundary  (HTTPSEndpoint → HTTPS-Endpoint)
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      // Lowercase all
      .toLowerCase()
      // Collapse any run of non-alphanumeric chars to a single hyphen
      .replace(/[^a-z0-9]+/g, "-")
      // Trim leading/trailing hyphens
      .replace(/^-+|-+$/g, "")
  );
}

export function normalizeKey(rawKey: string): string {
  if (!rawKey) return rawKey;

  // Split on the first colon only — everything before is the category prefix.
  const colonIdx = rawKey.indexOf(":");
  if (colonIdx === -1) {
    return capLength(normalizeSegment(rawKey));
  }

  const catSlug = normalizeSegment(rawKey.slice(0, colonIdx));
  const bodySlug = normalizeSegment(rawKey.slice(colonIdx + 1));

  if (!catSlug) return capLength(bodySlug);
  if (!bodySlug) return catSlug;
  return capLength(`${catSlug}:${bodySlug}`);
}

// Merge the rawKey provenance into a fact's metadata jsonb field.
// Called only when normalizedKey !== rawKey to avoid polluting clean writes.
export function withRawKey(
  metadata: unknown,
  rawKey: string,
): Record<string, unknown> {
  const base =
    metadata != null && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  return { ...base, rawKey };
}
