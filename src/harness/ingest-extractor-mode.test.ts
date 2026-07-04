// Unit test — effectiveExtractorMode (ingest.ts), pure, no env/DB access.
//
// extraction-measurement.md §3 change 1: the harness must default to
// "heuristic" only when IRANTI_EXTRACTOR is unset, and otherwise respect
// whatever was pre-set (so `IRANTI_EXTRACTOR=local pnpm bench` actually
// does something, unlike before this change). This function is the whole
// decision, pulled out so it has a direct test independent of the
// env-mutation + vi.resetModules() dance the rest of the harness needs.

import { describe, expect, it } from "vitest";
import { effectiveExtractorMode } from "./ingest.js";

describe("effectiveExtractorMode", () => {
  it("defaults to heuristic when unset (undefined)", () => {
    expect(effectiveExtractorMode(undefined)).toBe("heuristic");
  });

  it("respects a pre-set value of 'local'", () => {
    expect(effectiveExtractorMode("local")).toBe("local");
  });

  it("respects a pre-set value of 'heuristic' explicitly", () => {
    expect(effectiveExtractorMode("heuristic")).toBe("heuristic");
  });

  it("respects an arbitrary future extractor mode string unchanged (no allowlist here)", () => {
    // Validating the string against a known set of modes is the extractor
    // selector's job (elsewhere) — this function's only contract is
    // "default-only", so it must not silently coerce an unrecognized value.
    expect(effectiveExtractorMode("frontier")).toBe("frontier");
  });

  it("treats an empty string as a pre-set value, not as unset", () => {
    // Mirrors connection.ts's own `!engineEnv` empty-string handling
    // elsewhere in this repo being a DELIBERATE special case there — this
    // function does not special-case empty string the same way, since an
    // empty IRANTI_EXTRACTOR is not a documented "explicitly heuristic"
    // signal the way an empty IRANTI_DB_ENGINE is for DATABASE_URL
    // fallback. Pinning current behavior so a future change here is a
    // conscious decision, not an accident.
    expect(effectiveExtractorMode("")).toBe("");
  });
});
