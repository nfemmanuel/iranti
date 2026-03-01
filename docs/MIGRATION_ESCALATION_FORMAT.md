# Migration Guide: Human Escalation Format

## Breaking Change

As of this update, human escalation resolutions must be provided in strict JSON format. Free-text resolutions are no longer supported.

---

## Old Format (No Longer Supported)

```markdown
## HUMAN RESOLUTION

After reviewing both sources, I've determined that the researcher is actually 
affiliated with Stanford, not MIT. The OpenAlex data was outdated.
```

**Problem**: This required LLM parsing, which could misinterpret human intent.

---

## New Format (Required)

```markdown
## HUMAN RESOLUTION

{
  "value": "Stanford University",
  "summary": "Researcher is affiliated with Stanford University"
}
```

**Benefits**: 
- Deterministic parsing (no LLM interpretation)
- Human decision is ground truth
- Clear structure for complex values

---

## Format Rules

1. **Must be valid JSON** - Use a JSON validator if unsure
2. **Must have both fields**:
   - `value`: The authoritative fact (can be string, number, object, array)
   - `summary`: One sentence description (string)
3. **Can include comments** - HTML comments are stripped before parsing
4. **Status must be RESOLVED** - Change `**Status:** PENDING` to `**Status:** RESOLVED`

---

## Examples

### Simple String Value
```json
{
  "value": "MIT",
  "summary": "Researcher is affiliated with MIT"
}
```

### Complex Object Value
```json
{
  "value": {
    "institution": "Stanford University",
    "department": "Computer Science",
    "role": "Associate Professor"
  },
  "summary": "Researcher is Associate Professor in CS at Stanford"
}
```

### Numeric Value
```json
{
  "value": 2024,
  "summary": "Project deadline is 2024"
}
```

### Array Value
```json
{
  "value": ["Python", "TypeScript", "Rust"],
  "summary": "Project uses Python, TypeScript, and Rust"
}
```

---

## Migration Steps for Existing Escalations

If you have pending escalations in the old format:

1. Open the escalation file in `escalation/active/`
2. Replace the free-text resolution with JSON format
3. Change `**Status:** PENDING` to `**Status:** RESOLVED`
4. Save the file
5. Next Archivist run will process it

---

## Error Messages

If your JSON is invalid, you'll see clear errors in the Archivist report:

- `"No JSON found in HUMAN RESOLUTION section"` - Add JSON block
- `"JSON must have 'value' and 'summary' fields"` - Add missing fields
- `"Invalid JSON in HUMAN RESOLUTION: <error>"` - Fix JSON syntax

---

## Why This Change?

**Before**: Human writes free text → LLM interprets → LLM might misunderstand → Not ground truth

**After**: Human writes JSON → Direct parse → Exact intent preserved → True ground truth

This aligns with Iranti's core principle: "Human resolution is authoritative."

---

## Questions?

- Check `escalation/active/*.md` for template with instructions
- Validate JSON at https://jsonlint.com before saving
- See `FIXES_APPLIED.md` for technical details
