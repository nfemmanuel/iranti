# Escalation Resolution Template

When resolving a conflict, you must provide an **AUTHORITATIVE_JSON** block. This is the only data that will be committed to the knowledge base.

## Required Format

````md
## HUMAN RESOLUTION
Status: RESOLVED

### AUTHORITATIVE_JSON
```json
{
  "entityType": "researcher",
  "entityId": "orcid:0000-0002-1825-0097",
  "key": "affiliation",
  "value": { "text": "MIT" },
  "summary": "MIT",
  "validUntil": "2026-06-01T00:00:00.000Z",
  "notes": "Verified on ORCID profile."
}
```
````

## Field Requirements

**Mandatory:**
- `entityType` - Entity type (e.g., "researcher", "project")
- `entityId` - Entity identifier
- `key` - Fact key
- `value` - Fact value (any valid JSON)
- `summary` - Human-readable summary

**Optional:**
- `validUntil` - ISO 8601 timestamp or null
- `notes` - Additional context for humans

## Important

- Only `AUTHORITATIVE_JSON` is committed to the KB
- LLM enrichment (if present) is stored separately and labeled non-authoritative
- Missing or invalid JSON → no write happens, file stays in `/active`
