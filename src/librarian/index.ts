import { createHash } from 'crypto';
import { route } from '../lib/router';
import {
    appendConflictLog,
    archiveEntry,
    canWriteToStaffNamespace,
    createEntry,
    createWriteReceipt,
    deleteEntryById,
    findEntry,
    getWriteReceipt,
    insertArchiveFromCurrent,
    isProtectedEntry,
} from '../library/queries';
import { withIdentityLock } from '../library/locks';
import { EntryInput } from '../types';
import {
    ArchivedReason,
    KnowledgeEntry,
    ResolutionOutcome,
    ResolutionState,
} from '../generated/prisma/client';
import { ChunkInput } from './chunker';
import { updateStats } from '../library/agent-registry';
import { enforceWritePermissions } from './guards';
import { getConflictPolicy } from './getPolicy';
import { scoreCandidate } from './scoring';
import { recordResolution } from './source-reliability';
import { inc, timeEnd, timeStart } from '../lib/metrics';
import { ensureEscalationFolders } from '../lib/escalationPaths';

function clampConfidence(input: EntryInput): EntryInput {
    return {
        ...input,
        confidence: Math.min(100, Math.max(0, Math.round(input.confidence))),
    };
}

function validateTemporalInput(input: EntryInput): void {
    if (input.validUntil !== undefined && input.validUntil !== null) {
        throw new Error('validUntil is not accepted on writes in this temporal-versioning MVP.');
    }

    if (input.validFrom && input.validFrom.getTime() > Date.now()) {
        throw new Error('validFrom cannot be in the future.');
    }
}

type WriteAction = 'created' | 'updated' | 'escalated' | 'rejected';

type ReliabilityUpdate = {
    winnerSource: string;
    loserSource: string;
    humanOverride: boolean;
};

type WriteResultInternal = {
    action: WriteAction;
    entry?: KnowledgeEntry;
    reason: string;
    idempotentReplay?: boolean;
    reliabilityUpdate?: ReliabilityUpdate;
};

function buildReliabilityUpdate(winnerSource: string, loserSource: string): ReliabilityUpdate | undefined {
    if (winnerSource === loserSource) return undefined;
    return {
        winnerSource,
        loserSource,
        humanOverride: winnerSource === 'HumanReview' || loserSource === 'HumanReview',
    };
}

async function saveReceipt(
    input: EntryInput,
    outcome: string,
    entryId: number | null,
    tx: any,
    escalationFile?: string
) {
    if (!input.requestId) return;
    await createWriteReceipt({
        requestId: input.requestId,
        entityType: input.entityType,
        entityId: input.entityId,
        key: input.key,
        outcome,
        resultEntryId: entryId,
        escalationFile,
    }, tx);
}

async function logDecision(
    entryId: number,
    type: string,
    incoming: EntryInput,
    existingScore: number,
    incomingScore: number,
    reason: string,
    usedLLM: boolean,
    tx: any
) {
    await appendConflictLog(entryId, {
        type,
        at: new Date().toISOString(),
        incoming: {
            valueRaw: incoming.valueRaw,
            valueSummary: incoming.valueSummary,
            confidence: incoming.confidence,
            source: incoming.source,
        },
        existingScore: existingScore > 0 ? existingScore : undefined,
        incomingScore: incomingScore > 0 ? incomingScore : undefined,
        reason,
        usedLLM,
    }, tx);
}

async function replaceEntry(existing: KnowledgeEntry, incoming: EntryInput, tx: any): Promise<KnowledgeEntry> {
    await archiveEntry(existing, ArchivedReason.superseded, {
        entityType: incoming.entityType,
        entityId: incoming.entityId,
        key: incoming.key,
    }, tx);

    return createEntry({
        ...incoming,
        validFrom: incoming.validFrom ?? new Date(),
        validUntil: null,
    }, tx);
}

async function refetchCurrentRow(existing: KnowledgeEntry, tx: any): Promise<KnowledgeEntry> {
    const refreshed = await tx.knowledgeEntry.findUnique({
        where: { id: existing.id },
    });

    if (!refreshed) {
        throw new Error(`Expected current row ${existing.id} to exist during conflict handling.`);
    }

    return refreshed as KnowledgeEntry;
}

export async function librarianWrite(input: EntryInput): Promise<{
    action: WriteAction;
    entry?: KnowledgeEntry;
    reason: string;
    idempotentReplay?: boolean;
}> {
    const t0 = timeStart();
    input = clampConfidence(input);
    input.createdBy = input.createdBy.toLowerCase();
    validateTemporalInput(input);

    if (input.entityType === 'agent' && input.key === 'attendant_state') {
        const isStaff = new Set(['attendant', 'librarian', 'archivist', 'system', 'seed']).has(input.createdBy);
        if (!isStaff) {
            throw new Error('Write blocked: attendant_state is reserved for staff.');
        }
    }

    if (input.requestId) {
        const receipt = await getWriteReceipt(input.requestId);
        if (receipt) {
            timeEnd('librarian.write_ms', t0);
            return {
                action: receipt.outcome as WriteAction,
                reason: 'Idempotent replay of previous request',
                idempotentReplay: true,
            };
        }
    }

    enforceWritePermissions({
        entityType: input.entityType,
        entityId: input.entityId,
        key: input.key,
        createdBy: input.createdBy,
    });

    const writeResult = await withIdentityLock(
        { entityType: input.entityType, entityId: input.entityId, key: input.key },
        async (tx): Promise<WriteResultInternal> => {
            if (!canWriteToStaffNamespace(input.createdBy, input.entityType)) {
                return {
                    action: 'rejected',
                    reason: `Staff namespace '${input.entityType}' is protected. Only staff writers can modify it.`,
                };
            }

            const protectedEntry = await isProtectedEntry({
                entityType: input.entityType,
                entityId: input.entityId,
                key: input.key,
            }, tx);

            if (protectedEntry) {
                return {
                    action: 'rejected',
                    reason: 'Entry is protected. Only the seed script can write to the Staff Namespace.',
                };
            }

            const existing = await findEntry({
                entityType: input.entityType,
                entityId: input.entityId,
                key: input.key,
            }, tx);

            if (!existing) {
                const entry = await createEntry({
                    ...input,
                    validFrom: input.validFrom ?? new Date(),
                    validUntil: null,
                }, tx);
                await updateStats(input.createdBy, 'created', input.confidence);
                await saveReceipt(input, 'created', entry.id, tx);
                inc('librarian.created');
                return { action: 'created', entry, reason: 'No existing entry found. Created.' };
            }

            return resolveConflict(existing, input, tx);
        }
    );

    if (writeResult.reliabilityUpdate) {
        try {
            await recordResolution(
                writeResult.reliabilityUpdate.winnerSource,
                writeResult.reliabilityUpdate.loserSource,
                writeResult.reliabilityUpdate.humanOverride
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn('[librarian] reliability update failed:', reason);
        }
    }

    if (writeResult.action === 'updated' || writeResult.action === 'rejected' || writeResult.action === 'escalated') {
        await updateStats(input.createdBy, writeResult.action, input.confidence);
    }

    const { reliabilityUpdate: _ignored, ...publicResult } = writeResult;
    timeEnd('librarian.write_ms', t0);
    return publicResult;
}

async function resolveConflict(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    tx: any
): Promise<WriteResultInternal> {
    const policy = await getConflictPolicy(tx);
    const candidate: EntryInput = { ...incoming, validUntil: null };

    if (existing.confidence === candidate.confidence) {
        if (existing.source === candidate.source) {
            const entry = await replaceEntry(existing, candidate, tx);
            await logDecision(
                entry.id,
                'CONFLICT_REPLACED',
                candidate,
                existing.confidence,
                candidate.confidence,
                'Equal confidence from same source; accepted latest update.',
                false,
                tx
            );
            await saveReceipt(candidate, 'updated', entry.id, tx);
            inc('librarian.updated');
            return { action: 'updated', entry, reason: 'Equal confidence same-source update accepted.' };
        }

        await logDecision(existing.id, 'CONFLICT_ESCALATED', candidate, existing.confidence, candidate.confidence, 'Identical confidence requires human judgment', false, tx);
        inc('librarian.escalated');
        return escalateConflict(existing, candidate, tx);
    }

    if (JSON.stringify(existing.valueRaw) === JSON.stringify(candidate.valueRaw)) {
        const existingScore = scoreCandidate({ confidence: existing.confidence, source: existing.source, validUntil: existing.validUntil, policy });
        const incomingScore = scoreCandidate({ confidence: candidate.confidence, source: candidate.source, validUntil: null, policy });

        if (Math.abs(incomingScore - existingScore) < 1.0) {
            await logDecision(existing.id, 'CONFLICT_ESCALATED', candidate, existingScore, incomingScore, 'Duplicate value with equal scores', false, tx);
            inc('librarian.escalated');
            return escalateConflict(existing, candidate, tx);
        }

        if (incomingScore > existingScore) {
            const entry = await replaceEntry(existing, candidate, tx);
            await logDecision(entry.id, 'CONFLICT_UPDATED', candidate, existingScore, incomingScore, 'Duplicate value, higher score', false, tx);
            await saveReceipt(candidate, 'updated', entry.id, tx);
            inc('librarian.updated');
            return {
                action: 'updated',
                entry,
                reason: 'Duplicate value. Updated confidence.',
                reliabilityUpdate: buildReliabilityUpdate(candidate.source, existing.source),
            };
        }

        await logDecision(existing.id, 'CONFLICT_REJECTED', candidate, existingScore, incomingScore, 'Duplicate value, lower score', false, tx);
        await saveReceipt(candidate, 'rejected', existing.id, tx);
        inc('librarian.rejected');
        return {
            action: 'rejected',
            reason: 'Duplicate value with lower score.',
            reliabilityUpdate: buildReliabilityUpdate(existing.source, candidate.source),
        };
    }

    const authSources = policy.authoritativeSourcesByKey[candidate.key] ?? [];
    if (authSources.length > 0) {
        const existingAuth = authSources.includes(existing.source);
        const incomingAuth = authSources.includes(candidate.source);

        if (existingAuth && !incomingAuth) {
            await logDecision(existing.id, 'CONFLICT_REJECTED', candidate, 0, 0, `Existing from authoritative source (${existing.source})`, false, tx);
            await saveReceipt(candidate, 'rejected', existing.id, tx);
            inc('librarian.rejected');
            return {
                action: 'rejected',
                reason: `Existing from authoritative source: ${existing.source}`,
                reliabilityUpdate: buildReliabilityUpdate(existing.source, candidate.source),
            };
        }

        if (incomingAuth && !existingAuth) {
            const entry = await replaceEntry(existing, candidate, tx);
            await logDecision(entry.id, 'CONFLICT_REPLACED', candidate, 0, 0, `Incoming from authoritative source (${candidate.source})`, false, tx);
            await saveReceipt(candidate, 'updated', entry.id, tx);
            inc('librarian.updated');
            return {
                action: 'updated',
                entry,
                reason: `Incoming from authoritative source: ${candidate.source}`,
                reliabilityUpdate: buildReliabilityUpdate(candidate.source, existing.source),
            };
        }
    }

    const existingScore = scoreCandidate({ confidence: existing.confidence, source: existing.source, validUntil: existing.validUntil, policy });
    const incomingScore = scoreCandidate({ confidence: candidate.confidence, source: candidate.source, validUntil: null, policy });
    const gap = Math.abs(incomingScore - existingScore);

    if (gap < 1.0) {
        await logDecision(existing.id, 'CONFLICT_ESCALATED', candidate, existingScore, incomingScore, 'Equal confidence scores require human judgment', false, tx);
        inc('librarian.escalated');
        return escalateConflict(existing, candidate, tx);
    }

    if (gap >= policy.minConfidenceToOverwrite) {
        if (incomingScore > existingScore) {
            const entry = await replaceEntry(existing, candidate, tx);
            await logDecision(entry.id, 'CONFLICT_REPLACED', candidate, existingScore, incomingScore, `Score gap ${gap.toFixed(1)} >= threshold ${policy.minConfidenceToOverwrite}`, false, tx);
            await saveReceipt(candidate, 'updated', entry.id, tx);
            inc('librarian.updated');
            return {
                action: 'updated',
                entry,
                reason: `Incoming score (${incomingScore.toFixed(1)}) higher than existing (${existingScore.toFixed(1)})`,
                reliabilityUpdate: buildReliabilityUpdate(candidate.source, existing.source),
            };
        }

        await logDecision(existing.id, 'CONFLICT_REJECTED', candidate, existingScore, incomingScore, `Score gap ${gap.toFixed(1)} >= threshold, existing wins`, false, tx);
        await saveReceipt(candidate, 'rejected', existing.id, tx);
        inc('librarian.rejected');
        return {
            action: 'rejected',
            reason: `Existing score (${existingScore.toFixed(1)}) higher than incoming (${incomingScore.toFixed(1)})`,
            reliabilityUpdate: buildReliabilityUpdate(existing.source, candidate.source),
        };
    }

    return resolveWithReasoning(existing, candidate, existingScore, incomingScore, tx);
}

async function resolveWithReasoning(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    existingScore: number,
    incomingScore: number,
    tx: any
): Promise<WriteResultInternal> {
    try {
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
            await logDecision(existing.id, 'CONFLICT_REJECTED', incoming, existingScore, incomingScore, `LLM: ${reason}`, true, tx);
            await saveReceipt(incoming, 'rejected', existing.id, tx);
            inc('librarian.rejected');
            return {
                action: 'rejected',
                reason: `LLM arbitration: ${reason}`,
                reliabilityUpdate: buildReliabilityUpdate(existing.source, incoming.source),
            };
        }

        if (text.startsWith('KEEP_INCOMING')) {
            const reason = text.replace('KEEP_INCOMING:', '').trim();
            const entry = await replaceEntry(existing, incoming, tx);
            await logDecision(entry.id, 'CONFLICT_REPLACED', incoming, existingScore, incomingScore, `LLM: ${reason}`, true, tx);
            await saveReceipt(incoming, 'updated', entry.id, tx);
            inc('librarian.updated');
            return {
                action: 'updated',
                entry,
                reason: `LLM arbitration: ${reason}`,
                reliabilityUpdate: buildReliabilityUpdate(incoming.source, existing.source),
            };
        }

        await logDecision(existing.id, 'CONFLICT_ESCALATED', incoming, existingScore, incomingScore, 'LLM recommended escalation', true, tx);
        inc('librarian.escalated');
        return escalateConflict(existing, incoming, tx);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await logDecision(existing.id, 'CONFLICT_ESCALATED', incoming, existingScore, incomingScore, `LLM error: ${reason}`, true, tx);
        inc('librarian.escalated');
        return escalateConflict(existing, incoming, tx);
    }
}

async function escalateConflict(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    tx: any
): Promise<{ action: 'escalated'; reason: string }> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const escalationPaths = await ensureEscalationFolders();
    const escalationTs = new Date();
    const current = await refetchCurrentRow(existing, tx);

    await insertArchiveFromCurrent(current, {
        reason: ArchivedReason.segment_closed,
        validFrom: current.validFrom,
        validUntil: escalationTs,
        resolutionState: ResolutionState.not_applicable,
        resolutionOutcome: ResolutionOutcome.not_applicable,
    }, tx);

    await insertArchiveFromCurrent(current, {
        reason: ArchivedReason.escalated,
        validFrom: escalationTs,
        validUntil: null,
        resolutionState: ResolutionState.pending,
        resolutionOutcome: ResolutionOutcome.not_applicable,
    }, tx);

    await deleteEntryById(current.id, tx);

    const baseFilename = buildEscalationFilename(
        incoming.entityType,
        incoming.entityId,
        incoming.key
    );

    let filename = baseFilename;
    let filePath = path.join(escalationPaths.active, filename);
    let appendedToExisting = false;

    const content = buildInitialEscalationContent(current, incoming);
    const updateBlock = buildEscalationUpdateBlock(current, incoming);

    try {
        await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
    } catch (err) {
        if ((err as any).code !== 'EEXIST') {
            throw err;
        }

        const existingContent = await fs.readFile(filePath, 'utf-8');
        const alreadyResolved = existingContent.includes('**Status:** RESOLVED');

        if (alreadyResolved) {
            filename = baseFilename.replace('.md', `_${Date.now()}.md`);
            filePath = path.join(escalationPaths.active, filename);
            await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
        } else {
            await fs.appendFile(filePath, updateBlock, { encoding: 'utf-8' });
            appendedToExisting = true;
        }
    }

    await saveReceipt(incoming, 'escalated', current.id, tx, filename);

    return {
        action: 'escalated',
        reason: appendedToExisting
            ? `Conflict appended to unresolved escalation file ${filePath}. Awaiting human resolution.`
            : `Conflict escalated to ${filePath}. Awaiting human resolution.`,
    };
}

function sanitizeEscalationPart(value: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return (normalized || 'unknown').slice(0, 64);
}

function buildEscalationFilename(entityType: string, entityId: string, key: string): string {
    const safeType = sanitizeEscalationPart(entityType);
    const safeId = sanitizeEscalationPart(entityId);
    const safeKey = sanitizeEscalationPart(key);
    const digest = createHash('sha1')
        .update(`${entityType}|${entityId}|${key}`)
        .digest('hex')
        .slice(0, 10);

    return `conflict_${safeType}_${safeId}_${safeKey}_${digest}.md`;
}

function buildConflictSnapshot(existing: KnowledgeEntry, incoming: EntryInput): string {
    return [
        `- **Detected at:** ${new Date().toISOString()}`,
        `- **Request ID:** ${incoming.requestId ?? 'none'}`,
        `- **Entity:** ${incoming.entityType} / ${incoming.entityId} / ${incoming.key}`,
        `- **Existing value:** ${JSON.stringify(existing.valueRaw)}`,
        `- **Existing confidence:** ${existing.confidence}`,
        `- **Incoming value:** ${JSON.stringify(incoming.valueRaw)}`,
        `- **Incoming confidence:** ${incoming.confidence}`,
        `- **Reasoning:** Ambiguous conflict requiring human judgment.`,
    ].join('\n');
}

function buildInitialEscalationContent(existing: KnowledgeEntry, incoming: EntryInput): string {
    const filename = buildEscalationFilename(incoming.entityType, incoming.entityId, incoming.key);
    const snapshot = buildConflictSnapshot(existing, incoming);

    return `# Escalation: ${filename}

## LIBRARIAN ASSESSMENT

${snapshot}
- **Status:** PENDING

### CONFLICT_EVENTS

#### EVENT_1
${snapshot}

## HUMAN RESOLUTION

Update **Status** above to \`RESOLVED\` when done, then provide authoritative JSON:

### AUTHORITATIVE_JSON
\`\`\`json
{
  "entityType": "${incoming.entityType}",
  "entityId": "${incoming.entityId}",
  "key": "${incoming.key}",
  "value": { "text": "..." },
  "summary": "One sentence summary",
  "notes": "Optional human notes"
}
\`\`\`
`;
}

function buildEscalationUpdateBlock(existing: KnowledgeEntry, incoming: EntryInput): string {
    const snapshot = buildConflictSnapshot(existing, incoming);
    const eventId = `EVENT_${Date.now()}`;
    return `\n#### ${eventId}\n${snapshot}\n`;
}

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
