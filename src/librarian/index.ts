/**
 * Librarian — the knowledge write arbiter for iranti.
 *
 * All mutations to the knowledge store flow through `librarianWrite`. The
 * function enforces a multi-layer conflict resolution pipeline before any row
 * is created, updated, or escalated:
 *
 *  1. Input validation — clamp confidence, block future `validFrom`, enforce
 *     write permissions (`guards.ts`), and check the `attendant_state` guard.
 *  2. Idempotency (M-2) — claim a `writeReceipt` slot before executing; replay
 *     if the requestId was already processed.
 *  3. Identity lock — advisory Postgres xact lock + in-process queue per
 *     `(entityType, entityId, key)` so concurrent writers serialise.
 *  4. Conflict resolution (in priority order):
 *     a. No existing entry → contextual conflict check then create.
 *     b. Direct user personal-memory correction → always replaces.
 *     c. Checkpoint continuity keys → replace without scoring.
 *     d. Equal confidence + same source → accept latest.
 *     e. Temporal tiebreak (validFrom) → newer wins.
 *     f. Authoritative source overrides → per-key policy.
 *     g. Score gap ≥ threshold → higher score wins.
 *     h. Close scores → LLM arbitration with sibling evidence (S4) or escalate.
 *  5. Escalation — unresolvable conflicts write a markdown file to the active
 *     escalation folder for human review; the Archivist later consumes
 *     `**Status:** RESOLVED` files.
 *  6. Post-write verification — immediate read-back check; emits staff event.
 *  7. Shared-state invalidation broadcast — notifies other processes that the
 *     entity has changed.
 *
 * `librarianIngest` is the bulk ingestion path: it calls the chunker to
 * extract structured facts from raw text, then writes each fact via `librarianWrite`.
 */

import { createHash } from 'crypto';
import { route } from '../lib/router';
import { getStaffEventEmitter } from '../lib/staffEventRegistry';
import {
    appendConflictLog,
    archiveEntry,
    canWriteToStaffNamespace,
    claimWriteReceiptSlot,
    clearPendingWriteReceiptSlot,
    createEntry,
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
    PrismaClient,
    ResolutionOutcome,
    ResolutionState,
} from '../generated/prisma/client';

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
import { ChunkInput } from './chunker';
import { updateStats } from '../library/agent-registry';
import { enforceWritePermissions } from './guards';
import { getConflictPolicy } from './getPolicy';
import { scoreCandidate } from './scoring';
import { recordResolution } from './source-reliability';
import { inc, timeEnd, timeStart } from '../lib/metrics';
import { ensureEscalationFolders } from '../lib/escalationPaths';
import { detectContextualConflict } from './contextual-conflicts';
import { isPersonalMemoryKey, USER_PROMPT_AUTO_REMEMBER_SOURCE } from '../lib/autoRemember';
import { broadcastSharedEntityUpdated, notifySharedEntityUpdated } from '../lib/sharedStateInvalidation';

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

function normalizeSource(source: string): string {
    return source.trim().toLowerCase();
}

function isDirectUserMemorySource(source: string): boolean {
    const normalized = normalizeSource(source);
    return normalized === 'user_stated'
        || normalized === 'user_corrected'
        || normalized === normalizeSource(USER_PROMPT_AUTO_REMEMBER_SOURCE);
}

function isPersonalMemoryEntityType(entityType: string): boolean {
    const normalized = entityType.trim().toLowerCase();
    return normalized === 'user' || normalized === 'person';
}

function shouldPreferDirectUserPersonalCorrection(existing: KnowledgeEntry, candidate: EntryInput): boolean {
    if (!isPersonalMemoryEntityType(candidate.entityType) || !isPersonalMemoryKey(candidate.key)) {
        return false;
    }

    if (!isDirectUserMemorySource(candidate.source)) {
        return false;
    }

    if (normalizeSource(existing.source) === 'humanreview') {
        return false;
    }

    return JSON.stringify(existing.valueRaw) !== JSON.stringify(candidate.valueRaw);
}

const CHECKPOINT_CONTINUITY_KEYS = new Set([
    'current_step',
    'next_step',
    'open_risks',
    'recent_file_changes',
    'recent_actions',
    'checkpoint_summary',
]);

function shouldPreferCheckpointContinuityUpdate(existing: KnowledgeEntry, candidate: EntryInput): boolean {
    const properties = candidate.properties && typeof candidate.properties === 'object'
        ? candidate.properties as Record<string, unknown>
        : null;
    const capturePhase = typeof properties?.capturePhase === 'string' ? properties.capturePhase : null;
    const canonicalKey = typeof properties?.canonicalKey === 'string' ? properties.canonicalKey : candidate.key;

    if (candidate.source !== 'AttendantCheckpoint' || capturePhase !== 'checkpoint') {
        return false;
    }

    if (!CHECKPOINT_CONTINUITY_KEYS.has(canonicalKey)) {
        return false;
    }

    return JSON.stringify(existing.valueRaw) !== JSON.stringify(candidate.valueRaw);
}

function compareValidFrom(existing: KnowledgeEntry, incoming: EntryInput): 'existing' | 'incoming' | null {
    if (!existing.validFrom || !incoming.validFrom) {
        return null;
    }

    const existingTs = existing.validFrom.getTime();
    const incomingTs = incoming.validFrom.getTime();

    if (existingTs === incomingTs) {
        return null;
    }

    return incomingTs > existingTs ? 'incoming' : 'existing';
}

async function saveReceipt(
    input: EntryInput,
    outcome: string,
    entryId: number | null,
    tx: TransactionClient,
    escalationFile?: string
) {
    if (!input.requestId) return;
    // M-2: Use upsert — handles both the case where a slot was pre-claimed (pending) and where no slot exists yet
    await tx.writeReceipt.upsert({
        where: { requestId: input.requestId },
        update: { outcome, resultEntryId: entryId, escalationFile: escalationFile ?? null },
        create: {
            requestId: input.requestId,
            entityType: input.entityType,
            entityId: input.entityId,
            key: input.key,
            outcome,
            resultEntryId: entryId,
            escalationFile: escalationFile ?? null,
        },
    });
}

async function logDecision(
    entryId: number,
    type: string,
    incoming: EntryInput,
    existingScore: number,
    incomingScore: number,
    reason: string,
    usedLLM: boolean,
    tx: TransactionClient
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

async function replaceEntry(existing: KnowledgeEntry, incoming: EntryInput, tx: TransactionClient): Promise<KnowledgeEntry> {
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

async function refetchCurrentRow(existing: KnowledgeEntry, tx: TransactionClient): Promise<KnowledgeEntry> {
    const refreshed = await tx.knowledgeEntry.findUnique({
        where: { id: existing.id },
    });

    if (!refreshed) {
        throw new Error(`Expected current row ${existing.id} to exist during conflict handling.`);
    }

    return refreshed as KnowledgeEntry;
}

async function verifyImmediateWriteAvailability(input: EntryInput, writeResult: WriteResultInternal): Promise<void> {
    if ((writeResult.action !== 'created' && writeResult.action !== 'updated') || !writeResult.entry) {
        return;
    }

    const observed = await findEntry({
        entityType: input.entityType,
        entityId: input.entityId,
        key: input.key,
    });

    if (!observed) {
        throw new Error(
            `WRITE_AVAILABILITY_FAILED: ${input.entityType}/${input.entityId}/${input.key} was reported ${writeResult.action} but was not immediately queryable after commit.`
        );
    }

    if (observed.id !== writeResult.entry.id) {
        throw new Error(
            `WRITE_AVAILABILITY_FAILED: ${input.entityType}/${input.entityId}/${input.key} was reported ${writeResult.action} but immediate read observed entry ${observed.id} instead of ${writeResult.entry.id}.`
        );
    }
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

    try {
        if (input.entityType === 'agent' && input.key === 'attendant_state') {
            const isStaff = new Set(['attendant', 'librarian', 'archivist', 'system', 'seed']).has(input.createdBy);
            if (!isStaff) {
                throw new Error('Write blocked: attendant_state is reserved for staff.');
            }
        }

        if (input.requestId) {
            // M-2: Pending-before-write pattern — claim the requestId slot before executing the write.
            // This prevents two concurrent requests with the same requestId from both writing.
            const claimed = await claimWriteReceiptSlot({
                requestId: input.requestId,
                entityType: input.entityType,
                entityId: input.entityId,
                key: input.key,
            });

            if (!claimed) {
                // Another request already claimed this requestId
                const receipt = await getWriteReceipt(input.requestId);
                if (receipt && receipt.outcome !== 'pending') {
                    getStaffEventEmitter().emit({
                        staffComponent: 'Librarian',
                        actionType: 'write_deduplicated',
                        agentId: input.createdBy,
                        source: input.source,
                        entityType: input.entityType,
                        entityId: input.entityId,
                        key: input.key,
                        reason: 'Idempotent replay — requestId already processed.',
                        level: 'debug',
                        metadata: { requestId: input.requestId },
                    });
                    timeEnd('librarian.write_ms', t0);
                    return {
                        action: receipt.outcome as WriteAction,
                        reason: 'Idempotent replay of previous request',
                        idempotentReplay: true,
                    };
                }
                // Receipt is still pending (in-flight race) — treat as duplicate
                timeEnd('librarian.write_ms', t0);
                return {
                    action: 'rejected' as WriteAction,
                    reason: 'Request is already being processed (duplicate requestId in flight).',
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
                    const contextualConflict = await detectContextualConflict(input, tx);
                    if (contextualConflict) {
                        for (const matched of contextualConflict.matchedEntries) {
                            await logDecision(
                                matched.id,
                                'CONTEXTUAL_CONFLICT_REJECTED',
                                input,
                                matched.confidence,
                                input.confidence,
                                contextualConflict.reason,
                                false,
                                tx
                            );
                        }
                        await saveReceipt(input, 'rejected', contextualConflict.matchedEntries[0]?.id ?? null, tx);
                        inc('librarian.rejected');
                        getStaffEventEmitter().emit({
                            staffComponent: 'Librarian',
                            actionType: 'write_rejected',
                            agentId: input.createdBy,
                            source: input.source,
                            entityType: input.entityType,
                            entityId: input.entityId,
                            key: input.key,
                            reason: contextualConflict.reason,
                            level: 'audit',
                            metadata: { rejectionReason: 'contextual_conflict' },
                        });
                        return {
                            action: 'rejected',
                            reason: contextualConflict.reason,
                            reliabilityUpdate: contextualConflict.matchedEntries[0]
                                ? buildReliabilityUpdate(contextualConflict.matchedEntries[0].source, input.source)
                                : undefined,
                        };
                    }

                    const entry = await createEntry({
                        ...input,
                        validFrom: input.validFrom ?? new Date(),
                        validUntil: null,
                    }, tx);
                    await updateStats(input.createdBy, 'created', input.confidence);
                    await saveReceipt(input, 'created', entry.id, tx);
                    inc('librarian.created');
                    getStaffEventEmitter().emit({
                        staffComponent: 'Librarian',
                        actionType: 'write_created',
                        agentId: input.createdBy,
                        source: input.source,
                        entityType: input.entityType,
                        entityId: input.entityId,
                        key: input.key,
                        reason: 'No existing entry found. Created.',
                        level: 'audit',
                        metadata: {
                            confidence: input.confidence,
                            valuePreview: JSON.stringify(input.valueRaw).slice(0, 200),
                        },
                    });
                    return { action: 'created', entry, reason: 'No existing entry found. Created.' };
                }

                getStaffEventEmitter().emit({
                    staffComponent: 'Librarian',
                    actionType: 'conflict_detected',
                    agentId: input.createdBy,
                    source: input.source,
                    entityType: input.entityType,
                    entityId: input.entityId,
                    key: input.key,
                    reason: 'Existing entry found. Beginning conflict resolution.',
                    level: 'debug',
                    metadata: { existingConfidence: existing.confidence, incomingConfidence: input.confidence },
                });
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

        try {
            await verifyImmediateWriteAvailability(input, writeResult);
        } catch (error) {
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_availability_failed',
                agentId: input.createdBy,
                source: input.source,
                entityType: input.entityType,
                entityId: input.entityId,
                key: input.key,
                reason: 'post_commit_write_not_immediately_queryable',
                level: 'audit',
                metadata: {
                    action: writeResult.action,
                    entryId: writeResult.entry?.id ?? null,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            throw error;
        }

        if ((writeResult.action === 'created' || writeResult.action === 'updated') && writeResult.entry) {
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_available',
                agentId: input.createdBy,
                source: input.source,
                entityType: input.entityType,
                entityId: input.entityId,
                key: input.key,
                reason: 'post_commit_write_verified',
                level: 'audit',
                metadata: {
                    action: writeResult.action,
                    entryId: writeResult.entry.id,
                },
            });
            notifySharedEntityUpdated(`${input.entityType}/${input.entityId}`, input.key);
            void broadcastSharedEntityUpdated(`${input.entityType}/${input.entityId}`, input.key).catch((error) => {
                console.warn(`[shared-state] failed to broadcast invalidation for ${input.entityType}/${input.entityId}/${input.key}: ${error instanceof Error ? error.message : String(error)}`);
            });
        }

        const { reliabilityUpdate: _ignored, ...publicResult } = writeResult;
        timeEnd('librarian.write_ms', t0);
        return publicResult;
    } catch (err) {
        if (input.requestId) {
            try {
                await clearPendingWriteReceiptSlot(input.requestId);
            } catch (cleanupErr) {
                const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                console.warn('[librarian] failed to clear pending write receipt after error:', reason);
            }
        }
        timeEnd('librarian.write_ms', t0);
        throw err;
    }
}

async function resolveConflict(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    tx: TransactionClient
): Promise<WriteResultInternal> {
    const policy = await getConflictPolicy(tx);
    const candidate: EntryInput = { ...incoming, validUntil: null };

    if (shouldPreferDirectUserPersonalCorrection(existing, candidate)) {
        const entry = await replaceEntry(existing, candidate, tx);
        await logDecision(
            entry.id,
            'CONFLICT_REPLACED',
            candidate,
            existing.confidence,
            candidate.confidence,
            'Direct user personal-memory correction overrides prior non-human value.',
            false,
            tx
        );
        await saveReceipt(candidate, 'updated', entry.id, tx);
        inc('librarian.updated');
        getStaffEventEmitter().emit({
            staffComponent: 'Librarian',
            actionType: 'write_replaced',
            agentId: candidate.createdBy,
            source: candidate.source,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            key: candidate.key,
            reason: 'Direct user personal-memory correction overrides prior value.',
            level: 'audit',
            metadata: {
                confidence: candidate.confidence,
                priorConfidence: existing.confidence,
                priorSource: existing.source,
                valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
            },
        });
        return {
            action: 'updated',
            entry,
            reason: 'Direct user personal-memory correction overrides prior value.',
            reliabilityUpdate: buildReliabilityUpdate(candidate.source, existing.source),
        };
    }

    if (shouldPreferCheckpointContinuityUpdate(existing, candidate)) {
        const entry = await replaceEntry(existing, candidate, tx);
        await logDecision(
            entry.id,
            'CONFLICT_REPLACED',
            candidate,
            existing.confidence,
            candidate.confidence,
            'Checkpoint continuity update replaced prior shared recovery state.',
            false,
            tx
        );
        await saveReceipt(candidate, 'updated', entry.id, tx);
        inc('librarian.updated');
        getStaffEventEmitter().emit({
            staffComponent: 'Librarian',
            actionType: 'write_replaced',
            agentId: candidate.createdBy,
            source: candidate.source,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            key: candidate.key,
            reason: 'Checkpoint continuity update replaced prior shared recovery state.',
            level: 'audit',
            metadata: {
                confidence: candidate.confidence,
                priorConfidence: existing.confidence,
                priorSource: existing.source,
                valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
            },
        });
        return {
            action: 'updated',
            entry,
            reason: 'Checkpoint continuity update replaced prior shared recovery state.',
            reliabilityUpdate: buildReliabilityUpdate(candidate.source, existing.source),
        };
    }

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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_updated',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: 'Equal confidence same-source update accepted.',
                level: 'audit',
                metadata: {
                    confidence: candidate.confidence,
                    priorConfidence: existing.confidence,
                    valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
                },
            });
            return { action: 'updated', entry, reason: 'Equal confidence same-source update accepted.' };
        }

        const temporalWinner = compareValidFrom(existing, candidate);
        if (temporalWinner === 'incoming') {
            const entry = await replaceEntry(existing, candidate, tx);
            await logDecision(
                entry.id,
                'CONFLICT_REPLACED',
                candidate,
                existing.confidence,
                candidate.confidence,
                'Equal confidence tie broken by newer validFrom timestamp.',
                false,
                tx
            );
            await saveReceipt(candidate, 'updated', entry.id, tx);
            inc('librarian.updated');
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_updated',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: 'Equal confidence tie broken by newer validFrom.',
                level: 'audit',
                metadata: {
                    confidence: candidate.confidence,
                    priorConfidence: existing.confidence,
                    valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
                },
            });
            return {
                action: 'updated',
                entry,
                reason: 'Equal confidence tie broken by newer validFrom.',
                reliabilityUpdate: buildReliabilityUpdate(candidate.source, existing.source),
            };
        }

        if (temporalWinner === 'existing') {
            await logDecision(
                existing.id,
                'CONFLICT_REJECTED',
                candidate,
                existing.confidence,
                candidate.confidence,
                'Equal confidence tie broken by existing newer validFrom timestamp.',
                false,
                tx
            );
            await saveReceipt(candidate, 'rejected', existing.id, tx);
            inc('librarian.rejected');
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_rejected',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: 'Equal confidence tie broken by existing newer validFrom.',
                level: 'audit',
                metadata: { rejectionReason: 'temporal_tie_existing_wins' },
            });
            return {
                action: 'rejected',
                reason: 'Equal confidence tie broken by existing newer validFrom.',
                reliabilityUpdate: buildReliabilityUpdate(existing.source, candidate.source),
            };
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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'conflict_detected',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: 'Duplicate value with equal scores — escalating.',
                level: 'debug',
                metadata: { existingScore, incomingScore },
            });
            return escalateConflict(existing, candidate, tx);
        }

        if (incomingScore > existingScore) {
            const entry = await replaceEntry(existing, candidate, tx);
            await logDecision(entry.id, 'CONFLICT_UPDATED', candidate, existingScore, incomingScore, 'Duplicate value, higher score', false, tx);
            await saveReceipt(candidate, 'updated', entry.id, tx);
            inc('librarian.updated');
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_replaced',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: 'Duplicate value. Updated confidence.',
                level: 'audit',
                metadata: {
                    confidence: candidate.confidence,
                    priorConfidence: existing.confidence,
                    valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
                },
            });
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
        getStaffEventEmitter().emit({
            staffComponent: 'Librarian',
            actionType: 'write_rejected',
            agentId: candidate.createdBy,
            source: candidate.source,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            key: candidate.key,
            reason: 'Duplicate value with lower score.',
            level: 'audit',
            metadata: { rejectionReason: 'duplicate_value_lower_score' },
        });
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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_rejected',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: `Existing from authoritative source: ${existing.source}`,
                level: 'audit',
                metadata: { rejectionReason: 'authoritative_source_existing' },
            });
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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_replaced',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: `Incoming from authoritative source: ${candidate.source}`,
                level: 'audit',
                metadata: {
                    confidence: candidate.confidence,
                    priorConfidence: existing.confidence,
                    valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
                },
            });
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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_replaced',
                agentId: candidate.createdBy,
                source: candidate.source,
                entityType: candidate.entityType,
                entityId: candidate.entityId,
                key: candidate.key,
                reason: `Incoming score (${incomingScore.toFixed(1)}) higher than existing (${existingScore.toFixed(1)})`,
                level: 'audit',
                metadata: {
                    confidence: candidate.confidence,
                    priorConfidence: existing.confidence,
                    valuePreview: JSON.stringify(candidate.valueRaw).slice(0, 200),
                },
            });
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
        getStaffEventEmitter().emit({
            staffComponent: 'Librarian',
            actionType: 'write_rejected',
            agentId: candidate.createdBy,
            source: candidate.source,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            key: candidate.key,
            reason: `Existing score (${existingScore.toFixed(1)}) higher than incoming (${incomingScore.toFixed(1)})`,
            level: 'audit',
            metadata: { rejectionReason: 'score_gap_existing_wins' },
        });
        return {
            action: 'rejected',
            reason: `Existing score (${existingScore.toFixed(1)}) higher than incoming (${incomingScore.toFixed(1)})`,
            reliabilityUpdate: buildReliabilityUpdate(existing.source, candidate.source),
        };
    }

    return resolveWithReasoning(existing, candidate, existingScore, incomingScore, tx);
}

// S4: multi-step Librarian conflict resolution. Before the single-call LLM
// arbitration runs, gather sibling facts at the same entity (excluding the
// conflicting key itself) so the model can reason about which value is more
// consistent with the rest of the entity's known state. "examine -> gather
// -> decide" per the S-series design memo. The gather step is bounded so
// token budget stays predictable — at most MAX_CONFLICT_EVIDENCE_FACTS
// siblings are sent, ranked by confidence descending, and each summary is
// truncated to 200 chars.
const MAX_CONFLICT_EVIDENCE_FACTS = 5;
const CONFLICT_EVIDENCE_SUMMARY_MAX = 200;

async function gatherConflictEvidence(
    existing: KnowledgeEntry,
    tx: TransactionClient,
): Promise<Array<{ key: string; summary: string; confidence: number }>> {
    try {
        const siblings = await tx.knowledgeEntry.findMany({
            where: {
                entityType: existing.entityType,
                entityId: existing.entityId,
                NOT: { key: existing.key },
            },
            orderBy: [{ confidence: 'desc' }, { key: 'asc' }],
            take: MAX_CONFLICT_EVIDENCE_FACTS,
        });
        return siblings.map((sibling: KnowledgeEntry) => ({
            key: sibling.key,
            summary: (sibling.valueSummary ?? '').slice(0, CONFLICT_EVIDENCE_SUMMARY_MAX),
            confidence: sibling.confidence,
        }));
    } catch {
        // Evidence gathering is a best-effort enhancement. If the query
        // fails (db shape unexpected, stub tx in tests, etc.), fall back
        // to the original single-call behavior so conflicts still resolve.
        return [];
    }
}

function formatConflictEvidence(
    evidence: Array<{ key: string; summary: string; confidence: number }>,
): string {
    if (evidence.length === 0) {
        return 'None found (entity has no other facts on record).';
    }
    return evidence
        .map((fact) => `- ${fact.key} (confidence ${fact.confidence}): ${fact.summary}`)
        .join('\n');
}

async function resolveWithReasoning(
    existing: KnowledgeEntry,
    incoming: EntryInput,
    existingScore: number,
    incomingScore: number,
    tx: TransactionClient
): Promise<WriteResultInternal> {
    // S4: gather sibling context BEFORE the LLM call. Counted for metrics
    // so dashboards can observe how often multi-step arbitration runs.
    const evidence = await gatherConflictEvidence(existing, tx);
    inc('librarian.conflict_multi_step');
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

Related facts on this entity (evidence to reason with):
${formatConflictEvidence(evidence)}

Consider:
1. Which source is more authoritative for this type of data?
2. Which entry is more recent?
3. Are these values genuinely contradictory or measuring different things?
4. Which value is more consistent with the related facts above?
5. Can you determine a clear winner?

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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_rejected',
                agentId: incoming.createdBy,
                source: incoming.source,
                entityType: incoming.entityType,
                entityId: incoming.entityId,
                key: incoming.key,
                reason: `LLM arbitration: ${reason}`,
                level: 'audit',
                metadata: { rejectionReason: 'llm_arbitration_keep_existing' },
            });
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
            getStaffEventEmitter().emit({
                staffComponent: 'Librarian',
                actionType: 'write_replaced',
                agentId: incoming.createdBy,
                source: incoming.source,
                entityType: incoming.entityType,
                entityId: incoming.entityId,
                key: incoming.key,
                reason: `LLM arbitration: ${reason}`,
                level: 'audit',
                metadata: {
                    confidence: incoming.confidence,
                    priorConfidence: existing.confidence,
                    valuePreview: JSON.stringify(incoming.valueRaw).slice(0, 200),
                },
            });
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
    tx: TransactionClient
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
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
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

    getStaffEventEmitter().emit({
        staffComponent: 'Librarian',
        actionType: 'write_escalated',
        agentId: incoming.createdBy,
        source: incoming.source,
        entityType: incoming.entityType,
        entityId: incoming.entityId,
        key: incoming.key,
        reason: appendedToExisting
            ? `Conflict appended to unresolved escalation file ${filePath}. Awaiting human resolution.`
            : `Conflict escalated to ${filePath}. Awaiting human resolution.`,
        level: 'audit',
        metadata: {
            escalationId: filename,
            conflictReason: 'confidence_conflict',
            appendedToExisting,
        },
    });

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
    extractedCandidates: number;
    written: number;
    rejected: number;
    escalated: number;
    skippedMalformed: number;
    reason?: string;
    results: Array<{ key: string; action: string; reason: string }>;
}> {
    const { chunkContent } = await import('./chunker');

    const { chunks, extractedCandidates, skipped, reason } = await chunkContent(input);

    if (chunks.length === 0) {
        return {
            extractedCandidates,
            written: 0,
            rejected: 0,
            escalated: 0,
            skippedMalformed: skipped,
            reason,
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

    return {
        extractedCandidates,
        written,
        rejected,
        escalated,
        skippedMalformed: skipped,
        reason,
        results,
    };
}
