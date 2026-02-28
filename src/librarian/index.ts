import { route } from '../lib/router';
import { findEntry, createEntry, updateEntry, archiveEntry, isProtectedEntry } from '../library/queries';
import { EntryInput, EntryQuery, ConflictLogEntry } from '../types';
import { KnowledgeEntry } from '../generated/prisma/client';
import { ChunkInput } from './chunker';

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFLICT_THRESHOLD = 10;

// ─── Core Write Logic ────────────────────────────────────────────────────────

export async function librarianWrite(input: EntryInput): Promise<{
    action: 'created' | 'updated' | 'escalated' | 'rejected';
    entry?: KnowledgeEntry;
    reason: string;
}> {
    // Guard: never write to protected entries
    const protected_ = await isProtectedEntry({
        entityType: input.entityType,
        entityId: input.entityId,
        key: input.key,
    });

    if (protected_) {
        return {
            action: 'rejected',
            reason: 'Entry is protected. Only the seed script can write to the Staff Namespace.',
        };
    }

    const existing = await findEntry({
        entityType: input.entityType,
        entityId: input.entityId,
        key: input.key,
    });

    // No conflict — clean write
    if (!existing) {
        const entry = await createEntry(input);
        return { action: 'created', entry, reason: 'No existing entry found. Created.' };
    }

    // Exact duplicate — keep higher confidence
    if (JSON.stringify(existing.valueRaw) === JSON.stringify(input.valueRaw)) {
        if (input.confidence > existing.confidence) {
            const entry = await updateEntry(
                { entityType: input.entityType, entityId: input.entityId, key: input.key },
                { confidence: input.confidence, source: input.source }
            );
            return { action: 'updated', entry, reason: 'Duplicate value. Updated confidence.' };
        }
        return { action: 'rejected', reason: 'Duplicate value with equal or lower confidence. No change.' };
    }

    // Conflict detected — check confidence gap
    const gap = Math.abs(existing.confidence - input.confidence);

    if (gap >= CONFLICT_THRESHOLD) {
        return await resolveByConfidence(existing, input);
    }

    // Gap too small — use LLM reasoning before escalating
    return await resolveWithReasoning(existing, input);
}

// ─── Resolution ──────────────────────────────────────────────────────────────

async function resolveWithReasoning(
    existing: KnowledgeEntry,
    incoming: EntryInput
): Promise<{ action: 'created' | 'updated' | 'escalated' | 'rejected'; entry?: KnowledgeEntry; reason: string }> {
    const response = await route('conflict_resolution', [
        {
            role: 'user',
            content: `You are resolving a knowledge conflict between two AI agents.

Entity: ${incoming.entityType} / ${incoming.entityId} / ${incoming.key}

Existing entry:
- Value: ${JSON.stringify(existing.valueRaw)}
- Confidence: ${existing.confidence}
- Source: ${existing.source}
- Created: ${existing.createdAt.toISOString()}

Incoming entry:
- Value: ${JSON.stringify(incoming.valueRaw)}
- Confidence: ${incoming.confidence}
- Source: ${incoming.source}

Consider:
1. Which source is more authoritative for this type of data?
2. Which entry is more recent?
3. Are these values genuinely contradictory or measuring different things?
4. Can you determine a clear winner?

Respond with exactly one of these decisions and a one-sentence reason:
KEEP_EXISTING: <reason>
KEEP_INCOMING: <reason>
ESCALATE: <reason>`,
        },
    ], 512);

    const text = response.text.trim();

    if (text.startsWith('KEEP_EXISTING')) {
        const reason = text.replace('KEEP_EXISTING:', '').trim();
        return {
            action: 'rejected',
            reason: `Librarian reasoning: kept existing. ${reason}`,
        };
    }

    if (text.startsWith('KEEP_INCOMING')) {
        const reason = text.replace('KEEP_INCOMING:', '').trim();
        await archiveEntry(existing, 'superseded');
        const entry = await createEntry({
            ...incoming,
            conflictLog: [{
                detectedAt: new Date().toISOString(),
                incomingSource: incoming.source,
                incomingConfidence: incoming.confidence,
                existingConfidence: existing.confidence,
                resolution: 'overwritten',
                resolvedBy: 'librarian_reasoning',
                notes: reason,
            }] as unknown as never,
        });
        return {
            action: 'updated',
            entry,
            reason: `Librarian reasoning: replaced existing. ${reason}`,
        };
    }

    // ESCALATE or anything unexpected
    return await escalateConflict(existing, incoming);
}

// ─── Resolution ──────────────────────────────────────────────────────────────

async function resolveByConfidence(
    existing: KnowledgeEntry,
    incoming: EntryInput
): Promise<{ action: 'created' | 'updated' | 'escalated' | 'rejected'; entry?: KnowledgeEntry; reason: string }> {
    const conflictEntry: ConflictLogEntry = {
        detectedAt: new Date().toISOString(),
        incomingSource: incoming.source,
        incomingConfidence: incoming.confidence,
        existingConfidence: existing.confidence,
        resolution: incoming.confidence > existing.confidence ? 'overwritten' : 'kept',
        resolvedBy: 'librarian',
        notes: `Confidence gap: ${Math.abs(existing.confidence - incoming.confidence)}`,
    };

    if (incoming.confidence > existing.confidence) {
        await archiveEntry(existing, 'superseded');
        const entry = await createEntry({
            ...incoming,
            conflictLog: [conflictEntry] as unknown as never,
        });
        return {
            action: 'updated',
            entry,
            reason: `Incoming confidence (${incoming.confidence}) higher than existing (${existing.confidence}). Existing archived.`,
        };
    }

    return {
        action: 'rejected',
        reason: `Existing confidence (${existing.confidence}) higher than incoming (${incoming.confidence}). No change.`,
    };
}

async function escalateConflict(
    existing: KnowledgeEntry,
    incoming: EntryInput
): Promise<{ action: 'escalated'; reason: string }> {
    const fs = await import('fs/promises');
    const path = await import('path');

    const id = `conflict_${Date.now()}`;
    const filePath = path.join(process.cwd(), 'escalation', 'active', `${id}.md`);

    const content = `# Escalation: ${id}

## LIBRARIAN ASSESSMENT

- **Entity:** ${incoming.entityType} / ${incoming.entityId} / ${incoming.key}
- **Existing value:** ${JSON.stringify(existing.valueRaw)}
- **Existing confidence:** ${existing.confidence}
- **Incoming value:** ${JSON.stringify(incoming.valueRaw)}
- **Incoming confidence:** ${incoming.confidence}
- **Confidence gap:** ${Math.abs(existing.confidence - incoming.confidence)}
- **Reasoning:** Confidence gap below threshold (${CONFLICT_THRESHOLD}). Too close to resolve automatically.
- **Status:** PENDING

## HUMAN RESOLUTION

<!-- Write your resolution here in plain language. Change Status to RESOLVED when done. -->
`;

    await fs.writeFile(filePath, content, 'utf-8');

    return {
        action: 'escalated',
        reason: `Conflict escalated to ${filePath}. Awaiting human resolution.`,
    };
}

// ─── Chunk and Write ─────────────────────────────────────────────────────────

export async function librarianIngest(input: ChunkInput): Promise<{
    written: number;
    rejected: number;
    escalated: number;
    results: Array<{ key: string; action: string; reason: string }>;
}> {
    const { chunkContent } = await import('./chunker');

    const { chunks, reason } = await chunkContent(input);

    if (chunks.length === 0) {
        return {
            written: 0,
            rejected: 0,
            escalated: 0,
            results: [{ key: 'chunker', action: 'failed', reason: reason ?? 'No chunks produced' }],
        };
    }

    const results = [];
    let written = 0;
    let rejected = 0;
    let escalated = 0;

    for (const chunk of chunks) {
        const result = await librarianWrite(chunk);
        results.push({ key: chunk.key, action: result.action, reason: result.reason });

        if (result.action === 'created' || result.action === 'updated') written++;
        else if (result.action === 'escalated') escalated++;
        else rejected++;
    }

    return { written, rejected, escalated, results };
}