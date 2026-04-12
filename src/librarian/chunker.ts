/**
 * Librarian chunker — LLM-powered fact extraction for free-form text.
 *
 * Accepts a block of raw text about a single entity and returns a list of
 * structured `EntryInput` facts ready to be written to the knowledge store.
 * Uses the router's `extraction` task to pick a fast/cheap model.
 *
 * Extraction strategy:
 *  1. Primary pass — send the full `rawContent` to the LLM and parse the JSON
 *     array of `{ key, value, summary, confidence }` facts.
 *  2. Sentence-level fallback — if the primary pass returns zero facts AND the
 *     text splits into multiple sentences/paragraphs, retry each segment
 *     individually to capture facts that the full-context prompt missed.
 *  3. Deduplication — merge segments by key, keeping the first occurrence.
 *
 * Confidence blending: extracted confidence (0-100) is blended 70/30 with the
 * caller's `input.confidence` so that low-confidence ingestion paths can't be
 * inflated by an overconfident LLM extraction.
 */

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

function splitExtractionFallbackSegments(rawContent: string): string[] {
    const paragraphs = rawContent
        .replace(/\r\n/g, '\n')
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);

    const segments: string[] = [];
    for (const paragraph of paragraphs) {
        const sentenceLike = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [paragraph];
        for (const sentence of sentenceLike) {
            const trimmed = sentence.trim().replace(/^[-*•]\s*/, '').trim();
            if (trimmed.length > 0) {
                segments.push(trimmed);
            }
        }
    }

    return segments;
}

function shouldAttemptSentenceFallback(rawContent: string): boolean {
    return splitExtractionFallbackSegments(rawContent).length > 1;
}

function dedupeChunksByKey(chunks: EntryInput[]): EntryInput[] {
    const seen = new Set<string>();
    const deduped: EntryInput[] = [];
    for (const chunk of chunks) {
        if (seen.has(chunk.key)) {
            continue;
        }
        seen.add(chunk.key);
        deduped.push(chunk);
    }
    return deduped;
}

async function runExtractionPass(input: ChunkInput, text: string, retryLabel?: string): Promise<ChunkResult> {
    const prefix = retryLabel
        ? `This is a ${retryLabel}. Treat this excerpt independently and extract any fact directly stated here.\n\n`
        : '';

    const response = await route('extraction', [
        {
            role: 'user',
            content: `${prefix}You are extracting structured facts about exactly one entity.

Entity type: ${input.entityType}
Entity ID: ${input.entityId}
Source: ${input.source}

Text to chunk:
"${text}"

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
- If the full passage was too broad and returned nothing, this retry is allowed to extract sentence-level facts from this excerpt

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

// ─── Chunker ─────────────────────────────────────────────────────────────────

export async function chunkContent(input: ChunkInput): Promise<ChunkResult> {
    const primary = await runExtractionPass(input, input.rawContent);
    if (primary.chunks.length > 0) {
        return primary;
    }

    if (!shouldAttemptSentenceFallback(input.rawContent)) {
        return primary;
    }

    const segments = splitExtractionFallbackSegments(input.rawContent);
    const segmentChunks: EntryInput[] = [];
    let extractedCandidates = primary.extractedCandidates;
    let skipped = primary.skipped;

    for (let i = 0; i < segments.length; i += 1) {
        const segmentResult = await runExtractionPass(input, segments[i], `sentence-level retry ${i + 1} of ${segments.length}`);
        extractedCandidates += segmentResult.extractedCandidates;
        skipped += segmentResult.skipped;
        segmentChunks.push(...segmentResult.chunks);
    }

    const deduped = dedupeChunksByKey(segmentChunks);
    if (deduped.length === 0) {
        return primary;
    }

    return {
        chunks: deduped,
        extractedCandidates,
        skipped,
    };
}
