// Volatility classification — AX-7.
//
// A deterministic, pure classifier that flags writes whose VALUE is true only
// at the moment of writing — build status, running ports, "currently on
// branch X", timestamps-as-state. Old-iranti's live store accumulated exactly
// this class (`typecheck_status=clean` was the register's motivating
// example): a memory layer that replays a volatile fact days later actively
// misleads, which is worse than not storing it at all.
//
// Design posture (PRD D2, G1 non-goal): patterns only, no LLM judgment.
// Precision over recall — an uncaught volatile fact is the status quo (no
// regression); a wrongly-suppressed durable fact is a NEW harm this gate must
// not introduce. So every pattern here is narrow and enumerated, and every
// pattern ships with a fire fixture AND a near-miss fixture that must NOT
// fire (src/tests/volatility.test.ts).
//
// This module does no I/O — writeFact (src/library/facts.ts) calls
// classifyVolatility(key, value) at the write boundary and, when it returns
// true (and the caller hasn't passed durable: true), marks the fact
// transient via withTransient() (keys.ts's withRawKey precedent) instead of
// storing it as a normal durable fact. Nothing is dropped — see keys.ts /
// facts.ts for the downgrade-don't-drop mechanics (D1).

// ---------------------------------------------------------------------------
// Key-shape patterns
// ---------------------------------------------------------------------------

// `*_status` / `*-status` as a whole key or a trailing key segment — e.g.
// "typecheck_status", "build-status", "ci_status". Anchored to a segment
// boundary (start of string or a separator) so it doesn't fire on a key that
// merely CONTAINS "status" as a substring of a longer word.
const STATUS_KEY_PATTERN = /(^|[_-])status$/i;

// Bare "port"/"pid"/"running" as a whole key or a trailing key segment —
// "port", "server_port", "worker-pid", "is_running". NOT anchored to require
// "port"/"pid" alone stand as their own segment, so "reported" or "airport"
// (containing "port" as a substring, not a segment) do not fire.
const RUNTIME_NOUN_KEY_PATTERN = /(^|[_-])(port|pid|running)$/i;

// "currently-*" / "currently_*" prefix — "currently-on-branch",
// "currently_deployed_sha". A key-shape tell for "true right now, not
// necessarily true later."
const CURRENTLY_KEY_PREFIX_PATTERN = /^currently[_-]/i;

const KEY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "status-key", pattern: STATUS_KEY_PATTERN },
  { name: "runtime-noun-key", pattern: RUNTIME_NOUN_KEY_PATTERN },
  { name: "currently-key", pattern: CURRENTLY_KEY_PREFIX_PATTERN },
];

// ---------------------------------------------------------------------------
// Value-shape patterns
// ---------------------------------------------------------------------------

// A bare port number alongside a runtime noun — "server is running on port
// 3000", "the dev server is listening on port 8080". Requires a runtime verb
// (running/listening/up/live) in the SAME value, not just the word "port" —
// "port 3000 is the default for the dev server" has no runtime verb and must
// NOT fire (PRD acceptance criterion, must-not-fire fixture).
const PORT_RUNTIME_VALUE_PATTERN =
  /\b(?:running|listening|up|live)\b[^.]{0,40}\bport\s+\d{2,5}\b|\bport\s+\d{2,5}\b[^.]{0,40}\b(?:running|listening|up|live)\b/i;

// "is running/passing/green/clean (now|right now|currently)?"-class
// predicates — the direct "true only in this instant" assertion:
// "typecheck is clean", "the build is passing", "tests are green right now",
// "CI is running". Requires one of the volatile-state adjectives/verbs
// immediately as the predicate of an "is/are" clause.
const RUNTIME_STATE_PREDICATE_PATTERN =
  /\b(?:is|are)\s+(?:currently\s+)?(?:running|passing|green|clean|red|failing|up|down|live)\b(?:\s+(?:now|right\s+now))?/i;

// "on branch X" / "currently on branch X" — a snapshot of dev-environment
// state that changes as soon as someone checks out a different branch.
const CURRENT_BRANCH_VALUE_PATTERN = /\b(?:currently\s+)?on\s+branch\s+\S+/i;

const VALUE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "port-runtime-value", pattern: PORT_RUNTIME_VALUE_PATTERN },
  { name: "runtime-state-predicate", pattern: RUNTIME_STATE_PREDICATE_PATTERN },
  { name: "current-branch-value", pattern: CURRENT_BRANCH_VALUE_PATTERN },
];

// ---------------------------------------------------------------------------
// Must-not-fire guard: write-issue's JSON value shape.
// ---------------------------------------------------------------------------
//
// iranti_write_issue (src/mcp/tools/write-issue.ts) stores its fact VALUE as
// a JSON string: `{"title":...,"status":"open",...}`. That embedded
// `"status"` is the one real durable "status" in the codebase (an issue's
// lifecycle state, not a build/CI snapshot) — the classifier must not treat
// the substring "status" inside a JSON blob as a volatile value-shape hit.
// Because none of VALUE_PATTERNS matches on the bare word "status" (they all
// require a runtime verb/predicate), a JSON issue value already does not
// trip any value pattern — this guard exists as an explicit, tested
// recognition of that JSON shape so a future looser value pattern can't
// regress it silently (see src/tests/volatility.test.ts's must-not-fire case).
function looksLikeJsonValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export interface VolatilityMatch {
  volatile: boolean;
  // Which pattern fired, for audit/debugging. Undefined when volatile=false.
  matchedPattern?: string;
}

// classifyVolatility(key, value) — pure, deterministic. Returns whether this
// (key, value) pair looks like a volatile (moment-true) observation rather
// than a durable fact. Key-shape patterns are checked against the
// (normalizeKey'd or raw — caller's choice; this function does not
// normalize) key; value-shape patterns are checked against the value only
// when the value does not look like a JSON blob (write-issue guard above).
export function classifyVolatility(key: string, value: string): VolatilityMatch {
  for (const { name, pattern } of KEY_PATTERNS) {
    if (pattern.test(key)) {
      return { volatile: true, matchedPattern: name };
    }
  }

  if (!looksLikeJsonValue(value)) {
    for (const { name, pattern } of VALUE_PATTERNS) {
      if (pattern.test(value)) {
        return { volatile: true, matchedPattern: name };
      }
    }
  }

  return { volatile: false };
}
