// Deterministic artifact extraction — Phase 1
//
// iranti_attend is bidirectional: before fetching memory, it extracts
// structured artifacts (URLs, file paths) from the incoming message and
// stores them as facts. The extraction lives server-side so every AI host
// gets identical behavior — host-side extraction would drift per host.
//
// Design constraints (learned from iranti v0's auto-capture noise):
//
//   1. Conservative. Only extract things a regex can identify with near
//      certainty: URLs and file paths. No "smart" guessing — semantic
//      extraction (decisions, preferences) waits for the Phase 2
//      intelligence layer. Wrong facts are worse than missing facts.
//   2. Collision-safe keys. Facts upsert on (tenant, entity, key) — a
//      shared static key like "shared_url" would make every new URL
//      overwrite the previous one. Keys embed a content hash instead:
//      `shared_url:a1b2c3d4e5f6`. Re-sharing the same URL is a no-op upsert
//      (same key, same value); sharing a new URL creates a new fact.
//   3. Deduped and capped. Duplicates within a message are dropped, and at
//      most MAX_EXTRACTS_PER_MESSAGE artifacts are stored per attend call —
//      a message that pastes 200 links does not become 200 facts.
//   4. Tagged. Every extracted fact has source = EXTRACT_SOURCE so noisy
//      extracts are identifiable and bulk-cleanable later.
//
// This module is pure — no database access — so it is unit-testable
// without infrastructure.

import { createHash } from "crypto";

export const MAX_EXTRACTS_PER_MESSAGE = 10;
export const EXTRACT_SOURCE = "iranti_attend_extract";

export interface ExtractedArtifact {
  kind: "url" | "file_path";
  // The artifact itself — the URL or path, cleaned.
  value: string;
  // Collision-safe fact key: `<kind-prefix>:<12-hex content hash>`.
  key: string;
}

// --------------------------------------------------------------------------
// Patterns
// --------------------------------------------------------------------------

// URLs. Excludes closing delimiters so markdown links `[text](url)` and
// parenthesized URLs are captured cleanly.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;

// Windows paths: drive letter + separator + at least one segment.
// Excludes characters illegal in Windows paths.
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'<>|*?`]+/g;

// Unix absolute paths: require at least two segments (`/etc/hosts`, not `/a`)
// to avoid matching prose that happens to start with a slash. The lookbehind
// rejects matches embedded in other tokens — the `/src/foo` tail of
// `./src/foo`, or the path component of a bare domain like `docs.com/api`.
const UNIX_PATH_PATTERN = /(?<![\w.])\/[\w.-]+(?:\/[\w.-]+)+/g;

// Relative paths: must start with ./ or ../
const RELATIVE_PATH_PATTERN = /\.\.?[\\/][\w.-]+(?:[\\/][\w.-]+)*/g;

// Trailing punctuation that is almost always sentence punctuation, not part
// of the artifact: "see https://example.com." should not keep the dot.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

// --------------------------------------------------------------------------
// Extraction
// --------------------------------------------------------------------------

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function clean(raw: string): string {
  return raw.replace(TRAILING_PUNCTUATION, "");
}

function matchAll(message: string, pattern: RegExp): string[] {
  return [...message.matchAll(pattern)].map((m) => clean(m[0]));
}

// Extract all structured artifacts from a message, deduped and capped.
// Order is preserved: URLs first (highest signal), then file paths, each in
// order of appearance. The cap is applied after dedupe.
export function extractArtifacts(message: string): ExtractedArtifact[] {
  const seen = new Set<string>();
  const artifacts: ExtractedArtifact[] = [];

  const push = (kind: ExtractedArtifact["kind"], prefix: string, value: string) => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    artifacts.push({ kind, value, key: `${prefix}:${contentHash(value)}` });
  };

  for (const url of matchAll(message, URL_PATTERN)) {
    push("url", "shared_url", url);
  }

  // Strip URLs out before matching paths — a URL's path component
  // (`example.com/docs/api`) would otherwise match UNIX_PATH_PATTERN.
  const withoutUrls = message.replace(URL_PATTERN, " ");

  for (const path of matchAll(withoutUrls, WINDOWS_PATH_PATTERN)) {
    push("file_path", "referenced_file", path);
  }
  for (const path of matchAll(withoutUrls, RELATIVE_PATH_PATTERN)) {
    push("file_path", "referenced_file", path);
  }
  for (const path of matchAll(withoutUrls, UNIX_PATH_PATTERN)) {
    push("file_path", "referenced_file", path);
  }

  return artifacts.slice(0, MAX_EXTRACTS_PER_MESSAGE);
}

// --------------------------------------------------------------------------
// Alias extraction — Layer 0c (entity resolution, the "textbook" fix)
// --------------------------------------------------------------------------
//
// Learns a nickname for an artifact mentioned EARLIER IN THE SAME MESSAGE:
// "See <url> for the mocks — everyone just calls it 'the figma file'."
// Deterministic, heuristic-only (G1): a fixed set of quoted-nickname regex
// patterns, applied to the raw message text. The matched alias phrase is
// bound to the LAST artifact extractArtifacts() found in this same message
// (order of appearance) — never to prior-turn history, so the result is a
// pure function of (message, its own extracted artifacts).
//
// This module stays pure (no database access) — same contract as
// extractArtifacts above. The caller (mcp/tools/attend.ts) is responsible
// for persisting the result via src/library/aliases.ts's learnAlias.

export interface ExtractedAlias {
  // The nickname phrase as written, e.g. "the figma file". Trimmed, but not
  // case/whitespace-normalized here — src/library/aliases.ts's learnAlias
  // owns normalization at the storage boundary (same division of labor as
  // writeFact/normalizeKey).
  rawAlias: string;
  // The fact key of the artifact this alias resolves to (already
  // content-hash-suffixed by extractArtifacts, e.g. "shared_url:a1b2c3...").
  factKey: string;
}

// Quoted-nickname declarative patterns. Each captures the nickname text
// (without its surrounding quotes). Deliberately narrow and explicit —
// precision over recall, matching HeuristicExtractor's posture: a missed
// alias is far cheaper than a wrongly-bound one.
const ALIAS_PATTERNS: RegExp[] = [
  // "everyone calls it 'X'", "some people call it 'X'", "people calling it 'X'"
  /\b(?:everyone|some\s+people|people)\s+(?:just\s+)?call(?:s|ing)?\s+it\s+['"](.+?)['"]/i,
  // "I keep calling it 'X'", "I just call it 'X'", "I call it 'X'"
  /\bI\s+(?:keep\s+|just\s+)?call(?:s|ing)?\s+it\s+['"](.+?)['"]/i,
  // "we're calling it 'X'", "we are calling it 'X'"
  /\bwe(?:'re| are)\s+calling\s+it\s+['"](.+?)['"]/i,
  // "aka 'X'", "aka X" (quotes optional; stops at sentence punctuation)
  /\baka\s+['"]?(.+?)['"]?(?:[.,;]|$)/i,
];

// Extract at most one alias per message, bound to the LAST artifact
// extracted from that same message (order of appearance — see header
// comment). Returns [] when the message declares no artifact to bind to,
// even if an alias phrase matches — an alias with nothing to point at is
// not a fact yet (mirrors extractArtifacts's "wrong facts are worse than
// missing facts" precision stance).
export function extractAliases(
  message: string,
  artifactsInMessage: ExtractedArtifact[],
): ExtractedAlias[] {
  if (artifactsInMessage.length === 0) return [];

  for (const pattern of ALIAS_PATTERNS) {
    const m = message.match(pattern);
    if (!m?.[1]) continue;
    const rawAlias = m[1].trim();
    if (rawAlias.length < 2 || rawAlias.length > 80) continue;
    const target = artifactsInMessage[artifactsInMessage.length - 1]!;
    return [{ rawAlias, factKey: target.key }];
  }

  return [];
}
