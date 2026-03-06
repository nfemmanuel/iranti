import { route } from '../lib/router';
import { findEntry, createEntry, updateEntry, archiveEntry, isProtectedEntry, canWriteToStaffNamespace, appendConflictLog, getWriteReceipt, createWriteReceipt } from '../library/queries';
import { withIdentityLock } from '../library/locks';
import { EntryInput, EntryQuery, ConflictLogEntry } from '../types';
import { KnowledgeEntry } from '../generated/prisma/client';
import { ChunkInput } from './chunker';
import { updateStats } from '../library/agent-registry';
import { enforceWritePermissions } from './guards';
import { getConflictPolicy } from './getPolicy';
import { scoreCandidate } from './scoring';
import { recordResolution } from './source-reliability';
import { inc, timeStart, timeEnd } from '../lib/metrics';
import { ensureEscalationFolders } from '../lib/escalationPaths';
import { createHash } from 'crypto';

// ─── Input Validation ────────────────────────────────────────────────────────

function clampConfidence(input: EntryInput): EntryInput {
    return {
        ...input,
        confidence: Math.min(100, Math.max(0, Math.round(input.confidence))),
    };
}

function applyTTL(input: EntryInput, policy: any): EntryInput {
    if (input.validUntil) return input;
    const ttlDays = policy.ttlDefaultsByKey[input.key];
    if (!ttlDays) return input;
    
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + ttlDays);
    return { ...input, validUntil };
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

// ─── Core Write Logic ────────────────────────────────────────────────────────

export async function librarianWrite(input: EntryInput): Promise<{
    action: WriteAction;
    entry?: KnowledgeEntry;
    reason: string;
    idempotentReplay?: boolean;
}> {
    const t0 = timeStart();
    input = clampConfidence(input);
    input.createdBy = input.createdBy.toLowerCase();
    
    // Reserved key: attendant_state
    if (input.entityType === 'agent' && input.key === 'attendant_state') {
        const isStaff = new Set(['attendant', 'librarian', 'archivist', 'system', 'seed']).has(input.createdBy);
        if (!isStaff) {
            throw new Error('Write blocked: attendant_state is reserved for staff.');
        }
    }
    
    // Idempotency check (outside lock)
    if (input.requestId) {
        const receipt = await getWriteReceipt(input.requestId);
        if (receipt) {
            timeEnd('librarian.write_ms', t0);
            return {
                action: receipt.outcome as any,
                reason: 'Idempotent replay of previous request',
                idempotentReplay: true,
            };
        }
    }
    
    // Hard namespace protection (before lock)
    enforceWritePermissions({
        entityType: input.entityType,
        entityId: input.entityId,
        key: input.key,
        createdBy: input.createdBy,
    });
    
    // Serialize writes to same identity triple
    const writeResult = await withIdentityLock(
        { entityType: input.entityType, entityId: input.entityId, key: input.key },
        async (tx): Promise<WriteResultInternal> => {
            // P0: Enforce Staff namespace write ban
            if (!canWriteToStaffNamespace(input.createdBy, input.entityType)) {
                timeEnd('librarian.write_ms', t0);
                return {
                    action: 'rejected',
                    reason: `Staff namespace '${input.entityType}' is protected. Only staff writers can modify it.`,
                };
            }
            
            // Guard: never write to protected entries
            const protected_ = await isProtectedEntry({
                entityType: input.entityType,
                entityId: input.entityId,
                key: input.key,
            }, tx);

            if (protected_) {
                timeEnd('librarian.write_ms', t0);
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

            // No conflict — clean write
            if (!existing) {
                const policy = await getConflictPolicy(tx);
                const inputWithTTL = applyTTL(input, policy);
                const entry = await createEntry(inputWithTTL, tx);
                await updateStats(input.createdBy, 'created', input.confidence);
                
                if (input.requestId) {
                    await createWriteReceipt({
                        requestId: input.requestId,
                        entityType: input.entityType,
                        entityId: input.entityId,
                        key: input.key,
                        outcome: 'created',
                        resultEntryId: entry.id,
                    }, tx);
                }
                
                inc('librarian.created');
                timeEnd('librarian.write_ms', t0);
                return { action: 'created', entry, reason: 'No existing entry found. Created.' };
            }

            // Conflict detected — use policy engine
            const result = await resolveConflict(existing, input, tx);
            
            // Track outcome
            if (result.action === 'updated') inc('librarian.updated');
            else if (result.action === 'rejected') inc('librarian.rejected');
            else if (result.action === 'escalated') inc('librarian.escalated');
            
            timeEnd('librarian.write_ms', t0);
            return result;
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

    const { reliabilityUpdate: _ignored, ...publicResult } = writeResult;
    return publicResult;
}

// ─── Policy-Based Resolution ─────────────────────────────────────────────────

async function resolveConflict(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    tx: any
): Promise<WriteResultInternal> {
    const policy = await getConflictPolicy(tx);
    const inputWithTTL = applyTTL(incoming, policy);
    
    // Identical confidence values:
    // - same source: prefer latest update (common for user profile corrections)
    // - different source: escalate for human judgment
    if (existing.confidence === inputWithTTL.confidence) {
        if (existing.source === inputWithTTL.source) {
            const entry = await replaceEntry(existing, inputWithTTL, tx);
            await logDecision(
                existing.id,
                'CONFLICT_REPLACED',
                inputWithTTL,
                existing.confidence,
                inputWithTTL.confidence,
                'Equal confidence from same source; accepted latest update.',
                false,
                tx
            );
            await saveReceipt(inputWithTTL, 'updated', entry.id, tx);
            return { action: 'updated', entry, reason: 'Equal confidence same-source update accepted.' };
        }
        await logDecision(existing.id, 'CONFLICT_ESCALATED', inputWithTTL, existing.confidence, inputWithTTL.confidence, 'Identical confidence requires human judgment', false, tx);
        return await escalateConflict(existing, inputWithTTL, tx);
    }
    
    // Exact duplicate — escalate if equal scores, otherwise keep higher score
    if (JSON.stringify(existing.valueRaw) === JSON.stringify(inputWithTTL.valueRaw)) {
        const existingScore = scoreCandidate({ confidence: existing.confidence, source: existing.source, validUntil: existing.validUntil, policy });
        const incomingScore = scoreCandidate({ confidence: inputWithTTL.confidence, source: inputWithTTL.source, validUntil: inputWithTTL.validUntil, policy });
        
        // Check raw confidence values for exact equality first
        if (existing.confidence === inputWithTTL.confidence && existing.source === inputWithTTL.source) {
            // Truly identical - escalate
            await logDecision(existing.id, 'CONFLICT_ESCALATED', inputWithTTL, existingScore, incomingScore, 'Duplicate value with identical confidence and source', false, tx);
            return await escalateConflict(existing, inputWithTTL, tx);
        }
        
        if (Math.abs(incomingScore - existingScore) < 1.0) {
            // Equal scores - escalate for human decision
            await logDecision(existing.id, 'CONFLICT_ESCALATED', inputWithTTL, existingScore, incomingScore, 'Duplicate value with equal scores', false, tx);
            return await escalateConflict(existing, inputWithTTL, tx);
        }
        
        if (incomingScore > existingScore) {
            const entry = await updateEntry(
                { entityType: inputWithTTL.entityType, entityId: inputWithTTL.entityId, key: inputWithTTL.key },
                { confidence: inputWithTTL.confidence, source: inputWithTTL.source, validUntil: inputWithTTL.validUntil },
                tx
            );
            await logDecision(existing.id, 'CONFLICT_UPDATED', inputWithTTL, existingScore, incomingScore, 'Duplicate value, higher score', false, tx);
            await saveReceipt(inputWithTTL, 'updated', entry.id, tx);
            return {
                action: 'updated',
                entry,
                reason: 'Duplicate value. Updated confidence.',
                reliabilityUpdate: buildReliabilityUpdate(inputWithTTL.source, existing.source),
            };
        }
        
        await logDecision(existing.id, 'CONFLICT_REJECTED', inputWithTTL, existingScore, incomingScore, 'Duplicate value, lower score', false, tx);
        await saveReceipt(inputWithTTL, 'rejected', existing.id, tx);
        return {
            action: 'rejected',
            reason: 'Duplicate value with lower score.',
            reliabilityUpdate: buildReliabilityUpdate(existing.source, inputWithTTL.source),
        };
    }
    
    // Rule 1: Authoritative sources
    const authSources = policy.authoritativeSourcesByKey[inputWithTTL.key] ?? [];
    if (authSources.length > 0) {
        const existingAuth = authSources.includes(existing.source);
        const incomingAuth = authSources.includes(inputWithTTL.source);
        
        if (existingAuth && !incomingAuth) {
            await logDecision(existing.id, 'CONFLICT_REJECTED', inputWithTTL, 0, 0, `Existing from authoritative source (${existing.source})`, false, tx);
            await saveReceipt(inputWithTTL, 'rejected', existing.id, tx);
            return {
                action: 'rejected',
                reason: `Existing from authoritative source: ${existing.source}`,
                reliabilityUpdate: buildReliabilityUpdate(existing.source, inputWithTTL.source),
            };
        }
        
        if (incomingAuth && !existingAuth) {
            const entry = await replaceEntry(existing, inputWithTTL, tx);
            await logDecision(existing.id, 'CONFLICT_REPLACED', inputWithTTL, 0, 0, `Incoming from authoritative source (${inputWithTTL.source})`, false, tx);
            await saveReceipt(inputWithTTL, 'updated', entry.id, tx);
            return {
                action: 'updated',
                entry,
                reason: `Incoming from authoritative source: ${inputWithTTL.source}`,
                reliabilityUpdate: buildReliabilityUpdate(inputWithTTL.source, existing.source),
            };
        }
    }
    
    // Rule 2: Score-based resolution
    const existingScore = scoreCandidate({ confidence: existing.confidence, source: existing.source, validUntil: existing.validUntil, policy });
    const incomingScore = scoreCandidate({ confidence: inputWithTTL.confidence, source: inputWithTTL.source, validUntil: inputWithTTL.validUntil, policy });
    const gap = Math.abs(incomingScore - existingScore);
    
    // Check raw confidence values for exact equality first
    if (existing.confidence === inputWithTTL.confidence && existing.source === inputWithTTL.source) {
        // Truly identical - escalate
        await logDecision(existing.id, 'CONFLICT_ESCALATED', inputWithTTL, existingScore, incomingScore, 'Identical confidence and source require human judgment', false, tx);
        return await escalateConflict(existing, inputWithTTL, tx);
    }
    
    // Equal scores - escalate for human decision
    if (gap < 1.0) {
        await logDecision(existing.id, 'CONFLICT_ESCALATED', inputWithTTL, existingScore, incomingScore, 'Equal confidence scores require human judgment', false, tx);
        return await escalateConflict(existing, inputWithTTL, tx);
    }
    
    if (gap >= policy.minConfidenceToOverwrite) {
        if (incomingScore > existingScore) {
            const entry = await replaceEntry(existing, inputWithTTL, tx);
            await logDecision(existing.id, 'CONFLICT_REPLACED', inputWithTTL, existingScore, incomingScore, `Score gap ${gap.toFixed(1)} >= threshold ${policy.minConfidenceToOverwrite}`, false, tx);
            await saveReceipt(inputWithTTL, 'updated', entry.id, tx);
            return {
                action: 'updated',
                entry,
                reason: `Incoming score (${incomingScore.toFixed(1)}) higher than existing (${existingScore.toFixed(1)})`,
                reliabilityUpdate: buildReliabilityUpdate(inputWithTTL.source, existing.source),
            };
        } else {
            await logDecision(existing.id, 'CONFLICT_REJECTED', inputWithTTL, existingScore, incomingScore, `Score gap ${gap.toFixed(1)} >= threshold, existing wins`, false, tx);
            await saveReceipt(inputWithTTL, 'rejected', existing.id, tx);
            return {
                action: 'rejected',
                reason: `Existing score (${existingScore.toFixed(1)}) higher than incoming (${incomingScore.toFixed(1)})`,
                reliabilityUpdate: buildReliabilityUpdate(existing.source, inputWithTTL.source),
            };
        }
    }
    
    // Rule 3: Both below acceptance threshold → escalate
    if (Math.max(existingScore, incomingScore) < policy.minConfidenceToAccept) {
        await logDecision(existing.id, 'CONFLICT_ESCALATED', inputWithTTL, existingScore, incomingScore, 'Both below acceptance threshold', false, tx);
        return await escalateConflict(existing, inputWithTTL, tx);
    }
    
    // Rule 4: LLM arbitration
    return await resolveWithReasoning(existing, inputWithTTL, existingScore, incomingScore, policy, tx);
}

async function replaceEntry(existing: KnowledgeEntry, incoming: EntryInput, tx: any): Promise<KnowledgeEntry> {
    // Archive prior value, then update the same identity row.
    // This avoids unique-key insert failures on (entityType, entityId, key).
    await archiveEntry(existing, 'superseded', {
        entityType: existing.entityType,
        entityId: existing.entityId,
        key: existing.key,
    }, tx);

    return updateEntry(
        {
            entityType: existing.entityType,
            entityId: existing.entityId,
            key: existing.key,
        },
        {
            valueRaw: incoming.valueRaw,
            valueSummary: incoming.valueSummary,
            confidence: incoming.confidence,
            source: incoming.source,
            validUntil: incoming.validUntil,
            createdBy: incoming.createdBy,
            isProtected: incoming.isProtected ?? existing.isProtected,
        },
        tx
    );
}

async function logDecision(entryId: number, type: string, incoming: EntryInput, existingScore: number, incomingScore: number, reason: string, usedLLM: boolean, tx: any) {
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

async function saveReceipt(input: EntryInput, outcome: string, entryId: number, tx: any, escalationFile?: string) {
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

// ─── LLM Arbitration ─────────────────────────────────────────────────────────

async function resolveWithReasoning(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    existingScore: number,
    incomingScore: number,
    policy: any,
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
        
        return {
            action: 'rejected',
            reason: `LLM arbitration: ${reason}`,
            reliabilityUpdate: buildReliabilityUpdate(existing.source, incoming.source),
        };
    }

    if (text.startsWith('KEEP_INCOMING')) {
        const reason = text.replace('KEEP_INCOMING:', '').trim();
        const entry = await replaceEntry(existing, incoming, tx);
        await logDecision(existing.id, 'CONFLICT_REPLACED', incoming, existingScore, incomingScore, `LLM: ${reason}`, true, tx);
        await saveReceipt(incoming, 'updated', entry.id, tx);
        
        return {
            action: 'updated',
            entry,
            reason: `LLM arbitration: ${reason}`,
            reliabilityUpdate: buildReliabilityUpdate(incoming.source, existing.source),
        };
    }

    // ESCALATE or anything unexpected
    await logDecision(existing.id, 'CONFLICT_ESCALATED', incoming, existingScore, incomingScore, 'LLM recommended escalation', true, tx);
    return await escalateConflict(existing, incoming, tx);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await logDecision(existing.id, 'CONFLICT_ESCALATED', incoming, existingScore, incomingScore, `LLM error: ${reason}`, true, tx);
        return await escalateConflict(existing, incoming, tx);
    }
}

// ─── Escalation ──────────────────────────────────────────────────────────────

async function escalateConflict(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    tx: any
): Promise<{ action: 'escalated'; reason: string }> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const escalationPaths = await ensureEscalationFolders();

    const baseFilename = buildEscalationFilename(
        incoming.entityType,
        incoming.entityId,
        incoming.key
    );

    let filename = baseFilename;
    let filePath = path.join(escalationPaths.active, filename);
    let appendedToExisting = false;

    const content = buildInitialEscalationContent(existing, incoming);
    const updateBlock = buildEscalationUpdateBlock(existing, incoming);

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

    await appendConflictLog(existing.id, {
        type: 'CONFLICT_ESCALATED',
        at: new Date().toISOString(),
        incoming: {
            valueRaw: incoming.valueRaw,
            valueSummary: incoming.valueSummary,
            confidence: incoming.confidence,
            source: incoming.source,
        },
        reason: 'Escalated for human resolution',
        escalationFile: filename,
    }, tx);
    
    await saveReceipt(incoming, 'escalated', existing.id, tx, filename);

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
  "validUntil": null,
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
