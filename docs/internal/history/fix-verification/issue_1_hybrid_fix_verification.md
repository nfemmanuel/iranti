# Issue 1 (Hybrid) Fix Verification

## Implementation Complete

### Changes Made

#### 1. Escalation Template
- Created `docs/ESCALATION_TEMPLATE.md`
- Documents required `### AUTHORITATIVE_JSON` format
- Clarifies only authoritative JSON is committed to KB

#### 2. Deterministic JSON Extraction
- Renamed type to `AuthoritativeResolution`
- Added `validUntil` optional field
- Changed marker from `## HUMAN RESOLUTION` to `### AUTHORITATIVE_JSON`
- Validates 5 required fields: `entityType`, `entityId`, `key`, `value`, `summary`

#### 3. Authoritative Commit
- Extracts authoritative JSON (no LLM)
- Writes to KB with `confidence=100`, `source='HumanReview'`
- Parses `validUntil` to Date if provided

#### 4. LLM Enrichment (Non-Authoritative)
- Added `generateEnrichment()` function
- Runs AFTER authoritative commit
- Generates: explanation, suggestedValidUntil, normalizationWarnings
- Appends to file as `### LLM_ENRICHMENT (non-authoritative)`
- Enrichment failure does not block commit

#### 5. Fail-Closed Behavior
- Invalid JSON → error logged, file stays in `/active`
- Missing section → error logged, file stays in `/active`
- Enrichment failure → logged but commit succeeds

#### 6. Test Coverage
- Updated test suite: `tests/archivist_human_resolution_parsing.test.ts`
- Created verification script: `scripts/verify_authoritative_resolution_parsing.ts`
- 7 test cases covering all edge cases

## Acceptance Criteria ✓

- [x] Archivist commits HumanReview truth ONLY from AUTHORITATIVE_JSON
- [x] LLM output never changes value_raw / entityType/entityId/key
- [x] If JSON is missing/invalid, no write happens
- [x] LLM enrichment clearly labeled "non-authoritative" and stored separately

## Architecture

```
Human provides AUTHORITATIVE_JSON
         ↓
extractAuthoritativeJson() (deterministic, no LLM)
         ↓
Write to KB (confidence=100, source=HumanReview)
         ↓
generateEnrichment() (LLM, optional)
         ↓
Append LLM_ENRICHMENT to file (non-authoritative)
```

## Example Flow

**Input file:**
```markdown
### AUTHORITATIVE_JSON
```json
{
  "entityType": "researcher",
  "entityId": "orcid:123",
  "key": "affiliation",
  "value": { "text": "MIT" },
  "summary": "MIT"
}
```
```

**After processing:**
1. KB entry created with exact values from JSON
2. File appended with:
```markdown
### LLM_ENRICHMENT (non-authoritative)
```json
{
  "explanation": "Resolution confirms MIT affiliation",
  "suggestedValidUntil": "2026-01-01T00:00:00.000Z"
}
```
```

## Result

**Issue 1 (Hybrid) is FIXED.**

Human resolutions are ground truth. LLM enrichment adds intelligence without compromising authority.
