import fs from 'fs/promises';

type AuthoritativeResolution = {
    entityType: string;
    entityId: string;
    key: string;
    value: any;
    summary: string;
    validUntil?: string | null;
    notes?: string;
};

function extractAuthoritativeJson(fileText: string): AuthoritativeResolution {
    const marker = '### AUTHORITATIVE_JSON';
    const markerIndex = fileText.indexOf(marker);
    if (markerIndex === -1) {
        throw new Error("Missing '### AUTHORITATIVE_JSON' section.");
    }

    const afterMarker = fileText.slice(markerIndex + marker.length);
    const fenceStart = afterMarker.indexOf('```json');
    if (fenceStart === -1) {
        throw new Error('Missing ```json block after AUTHORITATIVE_JSON.');
    }

    const afterFence = afterMarker.slice(fenceStart + '```json'.length);
    const fenceEnd = afterFence.indexOf('```');
    if (fenceEnd === -1) {
        throw new Error('Unclosed ```json block in AUTHORITATIVE_JSON.');
    }

    const jsonText = afterFence.slice(0, fenceEnd).trim();

    let payload: any;
    try {
        payload = JSON.parse(jsonText);
    } catch {
        throw new Error('Invalid JSON in AUTHORITATIVE_JSON.');
    }

    for (const field of ['entityType', 'entityId', 'key', 'value', 'summary']) {
        if (payload[field] === undefined || payload[field] === null) {
            throw new Error(`AUTHORITATIVE_JSON missing required field: ${field}`);
        }
    }

    return payload as AuthoritativeResolution;
}

// Test with sample file
const sampleFile = `
**Status:** RESOLVED

## HUMAN RESOLUTION
Status: RESOLVED

### AUTHORITATIVE_JSON
\`\`\`json
{
  "entityType": "researcher",
  "entityId": "orcid:0000-0002-1825-0097",
  "key": "affiliation",
  "value": { "text": "MIT" },
  "summary": "MIT",
  "validUntil": "2026-06-01T00:00:00.000Z",
  "notes": "Verified on ORCID profile."
}
\`\`\`
`;

try {
    const result = extractAuthoritativeJson(sampleFile);
    console.log('✓ Parsing successful:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
} catch (err) {
    console.error('✗ Parsing failed:', err);
    process.exit(1);
}
