# Resolutionist

## Overview
The Resolutionist is an interactive CLI helper for human conflict review. It scans pending escalation files, presents the conflict context one file at a time, writes valid `AUTHORITATIVE_JSON`, and marks the file `RESOLVED` so the Archivist can commit the decision on the next maintenance pass.

## Inputs
| Input | Type | Description |
|---|---|---|
| `escalationDir` | `string` | Escalation root containing `active/`, `resolved/`, and `archived/` folders |
| Pending escalation file | Markdown | Librarian-authored escalation file with `**Status:** PENDING` and `### AUTHORITATIVE_JSON` |
| Reviewer choice | `1 \| 2 \| 3 \| S \| Q` | Accept existing, accept challenger, enter custom value, skip, or quit |
| Custom value | JSON | Reviewer-authored authoritative value when option `3` is selected |
| Summary | `string` | Required summary for custom resolutions |
| Reviewer confidence | `string` | Human-entered confidence note for custom resolutions |

## Outputs
| Output | Type | Description |
|---|---|---|
| Updated escalation file | Markdown | Same file with `AUTHORITATIVE_JSON` replaced and status marked `RESOLVED` |
| CLI summary | Console output | Counts of resolved, skipped, and remaining files |

## Decision Tree / Flow
1. Resolve the escalation root from `--dir`, `IRANTI_ESCALATION_DIR`, or `~/.iranti/escalation`.
2. Ensure `active/`, `resolved/`, and `archived/` folders exist.
3. Read markdown files in `active/` and keep only those still marked `**Status:** PENDING`.
4. For each pending file:
   1. Parse the entity descriptor, values, confidence scores, and Librarian reasoning.
   2. Show the conflict context to the reviewer.
   3. Prompt for one of five actions: accept existing, accept challenger, custom JSON, skip, or quit.
   4. Build authoritative payload:
      - existing/challenger: reuse the selected value and generate a deterministic summary
      - custom: require valid JSON and explicit summary, then record reviewer confidence in notes
   5. Replace the fenced `AUTHORITATIVE_JSON` block and switch `**Status:** PENDING` to `**Status:** RESOLVED`.
5. Exit cleanly on `Q` and print final counts for resolved, skipped, and remaining files.

## Edge Cases
- Missing or malformed markdown fields: file is skipped with a warning instead of crashing the session.
- Missing `AUTHORITATIVE_JSON` block: file is skipped and left pending.
- Missing `**Status:** PENDING` marker: file is ignored because the Archivist already considers only resolved files actionable.
- Invalid custom JSON: the Resolutionist re-prompts until valid JSON is entered.
- Empty escalation directory: prints a clear message and exits without error.

## Test Results
Manual validation:
- parsed the existing escalation markdown format under `escalation/active/`
- confirmed the Resolutionist writes the exact `AUTHORITATIVE_JSON` structure required by `src/archivist/index.ts`
- confirmed the CLI command delegates to the interactive resolver without modifying Archivist behavior

## Related
- [src/resolutionist/index.ts](/c:/Users/NF/Documents/Projects/iranti/src/resolutionist/index.ts)
- [scripts/iranti-cli.ts](/c:/Users/NF/Documents/Projects/iranti/scripts/iranti-cli.ts)
- [docs/guides/conflict-resolution.md](/c:/Users/NF/Documents/Projects/iranti/docs/guides/conflict-resolution.md)
- [src/archivist/index.ts](/c:/Users/NF/Documents/Projects/iranti/src/archivist/index.ts)
