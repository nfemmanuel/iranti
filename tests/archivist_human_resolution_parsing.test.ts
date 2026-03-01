import { describe, it, expect } from '@jest/globals';

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

describe('Archivist Authoritative Resolution Parsing', () => {
    it('parses valid resolution with all required fields', () => {
        const validFile = `
**Status:** RESOLVED

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
        const result = extractAuthoritativeJson(validFile);
        expect(result.entityType).toBe('researcher');
        expect(result.entityId).toBe('orcid:0000-0002-1825-0097');
        expect(result.key).toBe('affiliation');
        expect(result.value).toEqual({ text: 'MIT' });
        expect(result.summary).toBe('MIT');
        expect(result.validUntil).toBe('2026-06-01T00:00:00.000Z');
        expect(result.notes).toBe('Verified on ORCID profile.');
    });

    it('throws when AUTHORITATIVE_JSON section is missing', () => {
        const invalidFile = `
**Status:** RESOLVED

Some content without the required section.
`;
        expect(() => extractAuthoritativeJson(invalidFile)).toThrow(
            "Missing '### AUTHORITATIVE_JSON' section."
        );
    });

    it('throws when json code block is missing', () => {
        const invalidFile = `
**Status:** RESOLVED

### AUTHORITATIVE_JSON
Just plain text, no code block.
`;
        expect(() => extractAuthoritativeJson(invalidFile)).toThrow(
            'Missing ```json block after AUTHORITATIVE_JSON.'
        );
    });

    it('throws when json code block is not closed', () => {
        const invalidFile = `
**Status:** RESOLVED

### AUTHORITATIVE_JSON
\`\`\`json
{ "entityType": "test" }
`;
        expect(() => extractAuthoritativeJson(invalidFile)).toThrow(
            'Unclosed ```json block in AUTHORITATIVE_JSON.'
        );
    });

    it('throws when JSON is malformed', () => {
        const invalidFile = `
**Status:** RESOLVED

### AUTHORITATIVE_JSON
\`\`\`json
{ entityType: "test", invalid json }
\`\`\`
`;
        expect(() => extractAuthoritativeJson(invalidFile)).toThrow(
            'Invalid JSON in AUTHORITATIVE_JSON.'
        );
    });

    it('throws when required field entityType is missing', () => {
        const invalidFile = `
**Status:** RESOLVED

### AUTHORITATIVE_JSON
\`\`\`json
{
  "entityId": "test",
  "key": "test",
  "value": {},
  "summary": "test"
}
\`\`\`
`;
        expect(() => extractAuthoritativeJson(invalidFile)).toThrow(
            'AUTHORITATIVE_JSON missing required field: entityType'
        );
    });

    it('accepts resolution without optional validUntil and notes', () => {
        const validFile = `
**Status:** RESOLVED

### AUTHORITATIVE_JSON
\`\`\`json
{
  "entityType": "researcher",
  "entityId": "test123",
  "key": "affiliation",
  "value": { "text": "Stanford" },
  "summary": "Stanford"
}
\`\`\`
`;
        const result = extractAuthoritativeJson(validFile);
        expect(result.entityType).toBe('researcher');
        expect(result.validUntil).toBeUndefined();
        expect(result.notes).toBeUndefined();
    });
});
