// LLM JSON parsing — shared helper for nondeterministic LLM output.
//
// Local LLMs (Ollama qwen2.5, llava, etc.) frequently wrap their JSON
// responses in markdown fences (```json … ```) or precede the fence with
// prose like "Here is the result:". This is the ONE place in the codebase
// where that fuzzy LLM edge is tamed into deterministic behaviour.
//
// Both the semantic extractor (src/extract/index.ts) and the vision backend
// (src/media/vision.ts) pipe their raw LLM content through parseLlmJson so
// fence-handling is not duplicated and the strategy evolves in one place.

// ---------------------------------------------------------------------------
// parseLlmJson<T>
// ---------------------------------------------------------------------------

/**
 * Parse JSON from a raw LLM response string, tolerating markdown fences and
 * optional leading/trailing prose.
 *
 * Strategy (in order):
 *   1. Trim the input.
 *   2. Attempt to extract a fenced block — find the first ```[json] opening
 *      (possibly preceded by prose on the same or earlier lines) and the
 *      matching closing ```, then JSON.parse the content inside.
 *   3. If step 2 fails (no fence found, or the extracted content is not valid
 *      JSON), attempt a balanced-scan fallback: find the first `{` or `[`
 *      in the string, scan forward tracking brace/bracket depth while
 *      respecting string literals and escape sequences, extract the balanced
 *      substring, and JSON.parse it.
 *   4. If both strategies fail, throw — callers already wrap in try/catch and
 *      rely on a throw to trigger their degrade/fallback path.
 *
 * Throws on genuinely unparseable input (preserves the existing contract at
 * both call sites).
 */
export function parseLlmJson<T = unknown>(content: string): T {
  const trimmed = content.trim();
  if (!trimmed) throw new SyntaxError("parseLlmJson: empty input");

  // ------------------------------------------------------------------
  // Strategy 1: markdown fence extraction.
  //
  // Match an optional opening fence ```[json] — the fence may be preceded
  // by any amount of prose (the original vision regex only anchored at ^).
  // We look for the FIRST occurrence of ``` (optionally followed by "json"
  // and optional whitespace) and take the content until the next ```.
  // ------------------------------------------------------------------
  const fenceOpen = /```(?:json)?[ \t]*\r?\n?/;
  const fenceOpenIdx = trimmed.search(fenceOpen);
  if (fenceOpenIdx !== -1) {
    const fenceOpenMatch = fenceOpen.exec(trimmed.slice(fenceOpenIdx));
    if (fenceOpenMatch) {
      const bodyStart = fenceOpenIdx + fenceOpenMatch[0].length;
      const fenceCloseIdx = trimmed.indexOf("```", bodyStart);
      const fenced =
        fenceCloseIdx === -1
          ? trimmed.slice(bodyStart).trim()           // unclosed fence — take to end
          : trimmed.slice(bodyStart, fenceCloseIdx).trim();
      try {
        return JSON.parse(fenced) as T;
      } catch {
        // Fenced content was not valid JSON — fall through to strategy 2.
      }
    }
  }

  // ------------------------------------------------------------------
  // Strategy 2: balanced JSON value scan.
  //
  // Find the first `{` or `[` and scan forward keeping track of nesting
  // depth while correctly skipping over string literals (including escaped
  // characters). This handles:
  //   - JSON values preceded by prose with no fence at all.
  //   - Fenced responses where the fence extraction above produced invalid
  //     JSON (e.g. truncated or double-fenced output).
  //
  // Tradeoff: a greedy first-`{`-to-last-`}` regex would be two lines but
  // misidentifies `{` inside JSON string values (e.g. {"v":"a { b"}). The
  // balanced scan is O(n) and handles that correctly.
  // ------------------------------------------------------------------
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let scanStart = -1;
  if (firstBrace === -1 && firstBracket === -1) {
    // No JSON structure found at all.
    throw new SyntaxError(`parseLlmJson: no JSON object or array found in input`);
  } else if (firstBrace === -1) {
    scanStart = firstBracket;
  } else if (firstBracket === -1) {
    scanStart = firstBrace;
  } else {
    scanStart = Math.min(firstBrace, firstBracket);
  }

  const balanced = extractBalanced(trimmed, scanStart);
  if (balanced === null) {
    throw new SyntaxError(`parseLlmJson: unbalanced JSON structure in input`);
  }
  return JSON.parse(balanced) as T;
}

// ---------------------------------------------------------------------------
// extractBalanced — internal helper
//
// Starting at `startIdx` (which must be a `{` or `[`), scan forward tracking
// nesting depth while respecting:
//   - String literals delimited by `"` (the only JSON string delimiter).
//   - Escape sequences inside strings (`\"`, `\\`, etc.).
//   - Nested `{`/`[` and their matching `}`/`]`.
//
// Returns the balanced substring [startIdx, closeIdx] (inclusive), or null
// if the structure is never closed.
// ---------------------------------------------------------------------------

function extractBalanced(s: string, startIdx: number): string | null {
  const open = s[startIdx];
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;

  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (ch === "\\") {
        // Escape sequence — skip the next character unconditionally.
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Outside a string literal.
    if (ch === '"') {
      inString = true;
    } else if (ch === open || (ch === "{" && open === "[") || (ch === "[" && open === "{")) {
      // Track both brace types so mismatched nesting in the LLM output
      // doesn't cause us to stop too early.
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return s.slice(startIdx, i + 1);
      }
    }
  }

  return null; // Never closed.
}
