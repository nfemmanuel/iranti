# Write Guard Tracker Hygiene

Follow-up issue surfaced during the bidirectional attend design work. Not part of the attend feature itself but needs fixing before that feature ships.

## Context

The write guard (`.claude/iranti-write-guard-hook.js`) blocks `iranti_attend` until every tracked file edit has a corresponding `iranti_write`. The tracker that feeds it (`.claude/iranti-edit-tracker-hook.js`) is over-eager. In one observed session the pending list climbed to 21 entries, the majority non-meaningful.

## Observed issues

1. **Generated files get tracked.** `src/generated/prisma/**` shows up in the pending list after any `prisma generate` run. These are not hand-edited, regenerate on every schema change, and should not gate attend.
2. **Read-only access gets tracked.** Files that were only opened via `Read` have appeared in the pending list despite no `Edit` or `Write` call against them. Needs root-cause.
3. **Self-referential hook entries.** `.claude/iranti-write-guard-hook.js` and `.claude/iranti-edit-tracker-hook.js` have appeared in the pending list. Should be excluded.
4. **Path-casing duplicates.** Same spec file logged three times with different casings (absolute Windows path, relative path, and a second absolute path). Dedup must be case-insensitive on Windows and apply path normalization before adding to the pending list.

## Proposed fix scope

- Ignore list (directory prefix match) covering at minimum:
  - `src/generated/`
  - `node_modules/`
  - `.prisma/`
  - `dist/`, `build/`
  - `.claude/` (self-referential)
  - Any path matching `*.generated.*`
- Path normalization before dedup. Canonicalize to forward slashes, lowercase the drive letter on Windows, resolve to absolute path.
- Guarantee that only `Edit` and `Write` tool calls enter the tracker. Confirm `Read` is not a trigger and fix the leak if it is.
- Configurable ignore list per project via a config file so users can add their own generated directories without editing the hook.

## Why this must land before bidirectional attend

Bidirectional attend adds more attend calls per turn and relies on attend completing to run its capture step. Any guard-block on tracker noise becomes a capture-block too. The existing pathology (21 pending entries from a single session) would compound.

## Related

- [`.claude/iranti-write-guard-hook.js`](/c:/Users/NF/Documents/Projects/iranti/.claude/iranti-write-guard-hook.js)
- [`.claude/iranti-edit-tracker-hook.js`](/c:/Users/NF/Documents/Projects/iranti/.claude/iranti-edit-tracker-hook.js)
- [Bidirectional attend spec](/c:/Users/NF/Documents/Projects/iranti/docs/features/attend-bidirectional/spec.md)
