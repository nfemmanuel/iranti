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
    extractedCandidates: number;
    skipped: number;
    reason?: string;
}

type ExtractedFact = {
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
};

function isExtractedFact(value: unknown): value is ExtractedFact {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const item = value as Record<string, unknown>;
    return (
        typeof item.key === 'string'
        && item.key.trim().length > 0
        && item.value !== undefined
        && typeof item.summary === 'string'
        && item.summary.trim().length > 0
        && typeof item.confidence === 'number'
        && Number.isFinite(item.confidence)
    );
}

function clampConfidence(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
}

function blendConfidence(extractedConfidence: number, inputConfidence: number): number {
    return clampConfidence((extractedConfidence * 0.7) + (inputConfidence * 0.3));
}

// ─── Chunker ─────────────────────────────────────────────────────────────────

export async function chunkContent(input: ChunkInput): Promise<ChunkResult> {
    const response = await route('extraction', [
        {
            role: 'user',
            content: `You are extracting structured facts about exactly one entity.

Entity type: ${input.entityType}
Entity ID: ${input.entityId}
Source: ${input.source}

Text to chunk:
"${input.rawContent}"

Extract only distinct facts that clearly belong to this entity and can be represented as a concrete key/value pair.
Each fact must have:
- A short snake_case key describing what the fact is (e.g. "affiliation", "publication_count", "research_focus")
- A concrete JSON value (string, number, boolean, array, or object)
- A one-sentence summary
- A confidence score from 0 to 100 based on how explicitly the fact is stated in the text

Rules:
- Discard vague summaries, impressions, recommendations, and unsupported inferences
- If a fact is only weakly implied, either omit it or assign it a lower confidence than directly stated facts
- Do not invent keys or values that are not grounded in the text
- If you cannot express something as a clear key/value fact for this entity, discard it

Return ONLY a valid JSON array. No explanation, no markdown, no backticks.
Example:
[
  {"key": "affiliation", "value": {"institution": "MIT"}, "summary": "Affiliated with MIT.", "confidence": 94},
  {"key": "publication_count", "value": {"count": 24}, "summary": "Has published 24 papers.", "confidence": 90}
]

If no facts can be extracted, return an empty array: []`,
        },
    ], 1024);

    let parsed: unknown;

    try {
        const clean = response.text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
    } catch {
        return {
            chunks: [],
            extractedCandidates: 0,
            skipped: 0,
            reason: `Failed to parse LLM response: ${response.text.substring(0, 100)}`,
        };
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        return { chunks: [], extractedCandidates: 0, skipped: 0, reason: 'No facts extracted' };
    }

    const ingestMetadata = {
        method: 'llm_extraction',
        provider: response.providerUsed,
        model: response.model,
        originalSource: input.source,
        extractedAt: new Date().toISOString(),
    };

    const extractedFacts = parsed.filter(isExtractedFact);
    const chunks: EntryInput[] = extractedFacts
        .map((item) => ({
            entityType: input.entityType,
            entityId: input.entityId,
            key: item.key,
            valueRaw: item.value,
            valueSummary: item.summary,
            confidence: blendConfidence(item.confidence, input.confidence),
            source: input.source,
            createdBy: input.createdBy,
            properties: {
                ingest: ingestMetadata,
                extractedConfidence: clampConfidence(item.confidence),
                inputConfidence: clampConfidence(input.confidence),
            },
        }));

    return {
        chunks,
        extractedCandidates: parsed.length,
        skipped: parsed.length - extractedFacts.length,
    };
}
