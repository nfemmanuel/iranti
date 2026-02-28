import { route } from '../lib/router';
import { EntryInput, EntityType } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChunkInput {
    entityType: EntityType;
    entityId: string;
    rawContent: string;
    source: string;
    confidence: number;
    createdBy: string;
}

export interface ChunkResult {
    chunks: EntryInput[];
    skipped: number;
    reason?: string;
}

// ─── Chunker ─────────────────────────────────────────────────────────────────

export async function chunkContent(input: ChunkInput): Promise<ChunkResult> {
    const response = await route('extraction', [
        {
            role: 'user',
            content: `You are extracting atomic facts from a text blob about an entity.

Entity type: ${input.entityType}
Entity ID: ${input.entityId}
Source: ${input.source}

Text to chunk:
"${input.rawContent}"

Extract every distinct, verifiable fact as a separate entry.
Each fact must have:
- A short snake_case key describing what the fact is (e.g. "affiliation", "publication_count", "research_focus")
- A value (string, number, or simple object)
- A one-sentence summary

Return ONLY a valid JSON array. No explanation, no markdown, no backticks.
Example:
[
  {"key": "affiliation", "value": {"institution": "MIT"}, "summary": "Affiliated with MIT"},
  {"key": "publication_count", "value": {"count": 24}, "summary": "Has published 24 papers"}
]

If no facts can be extracted, return an empty array: []`,
        },
    ], 1024);

    let parsed: Array<{ key: string; value: unknown; summary: string }>;

    try {
        const clean = response.text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
    } catch {
        return {
            chunks: [],
            skipped: 0,
            reason: `Failed to parse LLM response: ${response.text.substring(0, 100)}`,
        };
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        return { chunks: [], skipped: 0, reason: 'No facts extracted' };
    }

    const chunks: EntryInput[] = parsed
        .filter((item) => item.key && item.value !== undefined && item.summary)
        .map((item) => ({
            entityType: input.entityType,
            entityId: input.entityId,
            key: item.key,
            valueRaw: item.value,
            valueSummary: item.summary,
            confidence: input.confidence,
            source: input.source,
            createdBy: input.createdBy,
        }));

    return {
        chunks,
        skipped: parsed.length - chunks.length,
    };
}