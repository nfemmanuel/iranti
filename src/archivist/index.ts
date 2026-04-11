import fs from 'fs/promises';
import path from 'path';
import { getStaffEventEmitter } from '../lib/staffEventRegistry';
import { getDb } from '../library/client';
import { archiveEntry, createEntry, findPendingEscalation } from '../library/queries';
import { complete } from '../lib/llm';
import { ensureEscalationFolders } from '../lib/escalationPaths';
import { ArchivedReason, ResolutionOutcome, ResolutionState, type PrismaClient } from '../generated/prisma/client';
import { calculateDecayedConfidence, getDecayConfig, readOriginalConfidence } from '../lib/decay';
import {
    planArchivistReasoningPass,
    ARCHIVIST_REASONING_DEFAULT_BUDGET,
    type ArchivistReasoningCandidate,
    type ArchivistReasoningProposal,
} from '../staff/archivistReasoning';
import { planCouncilConsultation, type CouncilConsultation } from '../staff/council';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD = 30;
const ARCHIVIST_REASONING_SCAN_LIMIT = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArchivistReport {
    expiredArchived: number;
    lowConfidenceArchived: number;
    duplicatesMerged: number;
    escalationsProcessed: number;
    errors: string[];
    reasoningProposals?: ArchivistReasoningProposal[];
    reasoningOutcome?: string;
    councilConsultations?: CouncilConsultation[];
}

type AuthoritativeResolution = {
    entityType: string;
    entityId: string;
    key: string;
    value: any;
    summary: string;
    notes?: string;
};

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

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

// ─── Main Cycle ──────────────────────────────────────────────────────────────

export async function runArchivist(): Promise<ArchivistReport> {
    const report: ArchivistReport = {
        expiredArchived: 0,
        lowConfidenceArchived: 0,
        duplicatesMerged: 0,
        escalationsProcessed: 0,
        errors: [],
    };

    await ensureEscalationFolders();
    await archiveExpired(report);
    await archiveLowConfidence(report);
    await applyMemoryDecay(report);
    await processEscalations(report);
    // B7 S5: bounded, deterministic reasoning pass — emits proposals only.
    await runReasoningPass(report);

    getStaffEventEmitter().emit({
        staffComponent: 'Archivist',
        actionType: 'archive_scan_completed',
        agentId: 'archivist',
        source: 'internal',
        reason: null,
        level: 'debug',
        metadata: {
            expiredArchived: report.expiredArchived,
            lowConfidenceArchived: report.lowConfidenceArchived,
            escalationsProcessed: report.escalationsProcessed,
            errors: report.errors.length,
            entriesScanned: report.expiredArchived + report.lowConfidenceArchived,
            reasoningProposals: report.reasoningProposals?.length ?? 0,
            reasoningOutcome: report.reasoningOutcome ?? 'skipped',
            councilConsultations: report.councilConsultations?.length ?? 0,
        },
    });

    return report;
}

// ─── B7 S5: Archivist reasoning pass ─────────────────────────────────────────

async function runReasoningPass(report: ArchivistReport): Promise<void> {
    let rows;
    try {
        rows = await getDb().knowledgeEntry.findMany({
            where: {
                isProtected: false,
                confidence: { gt: 0 },
            },
            take: ARCHIVIST_REASONING_SCAN_LIMIT,
            orderBy: { updatedAt: 'desc' },
        });
    } catch (err) {
        report.errors.push(`Reasoning pass: failed to load candidates: ${err}`);
        return;
    }

    const candidates: ArchivistReasoningCandidate[] = rows
        .filter((row) => row.valueSummary !== '[ARCHIVED]')
        .map((row) => ({
            id: row.id,
            entityType: row.entityType,
            entityId: row.entityId,
            key: row.key,
            confidence: row.confidence,
            source: row.source,
            lastAccessedAt: row.lastAccessedAt ?? null,
            updatedAt: row.updatedAt ?? null,
            createdAt: row.createdAt ?? null,
            valueSummary: row.valueSummary ?? null,
        }));

    const plan = planArchivistReasoningPass({
        candidates,
        reasoningBudget: ARCHIVIST_REASONING_DEFAULT_BUDGET,
    });

    report.reasoningProposals = plan.proposals;
    report.reasoningOutcome = plan.outcome;

    for (const proposal of plan.proposals) {
        getStaffEventEmitter().emit({
            staffComponent: 'Archivist',
            actionType: 'reasoning_proposal_emitted',
            agentId: 'archivist',
            source: 'internal',
            reason: proposal.reason,
            level: 'debug',
            metadata: {
                action: proposal.action,
                primaryEntityKey: proposal.primaryEntityKey,
                targetCount: proposal.targetIds.length,
                confidence: proposal.confidence,
                snapshot: proposal.snapshot,
            },
        });
    }

    // B7 S6: council mode — propose follow-up consultations when the
    // reasoning pass produced proposals. Emitted as observability only;
    // never executed here.
    if (plan.proposals.length > 0) {
        const topProposal = plan.proposals[0];
        const council = planCouncilConsultation({
            from: 'Archivist',
            task: `reasoning_pass_${topProposal.action}`,
            context: {
                reasoningProposalAction: topProposal.action,
            },
        });
        report.councilConsultations = council.consultations;
        for (const consultation of council.consultations) {
            getStaffEventEmitter().emit({
                staffComponent: 'Archivist',
                actionType: 'council_consultation_proposed',
                agentId: 'archivist',
                source: 'internal',
                reason: consultation.question,
                level: 'debug',
                metadata: {
                    from: consultation.from,
                    to: consultation.to,
                    basis: consultation.basis,
                    confidence: consultation.confidence,
                    topicHint: consultation.topicHint,
                },
            });
        }
    }
}

// ─── Expired Entries ─────────────────────────────────────────────────────────

async function archiveExpired(report: ArchivistReport): Promise<void> {
    const expired = await getDb().knowledgeEntry.findMany({
        where: {
            validUntil: { lt: new Date() },
            isProtected: false,
            confidence: { gt: 0 },
        },
    });

    for (const entry of expired) {
        try {
            await archiveEntry(entry, ArchivedReason.expired);
            getStaffEventEmitter().emit({
                staffComponent: 'Archivist',
                actionType: 'entry_archived',
                agentId: 'archivist',
                source: 'internal',
                entityType: entry.entityType,
                entityId: entry.entityId,
                key: entry.key,
                reason: 'Entry expired (validUntil in past)',
                level: 'audit',
                metadata: {
                    archivedReason: 'expired',
                    archivedFactId: String(entry.id),
                },
            });
            report.expiredArchived++;
        } catch (err) {
            report.errors.push(`Failed to archive expired entry ${entry.id}: ${err}`);
        }
    }
}

// ─── Low Confidence Entries ──────────────────────────────────────────────────

async function archiveLowConfidence(report: ArchivistReport): Promise<void> {
    const lowConfidence = await getDb().knowledgeEntry.findMany({
        where: {
            confidence: { lt: LOW_CONFIDENCE_THRESHOLD },
            isProtected: false,
        },
    });

    for (const entry of lowConfidence) {
        try {
            await archiveEntry(entry, ArchivedReason.expired);
            getStaffEventEmitter().emit({
                staffComponent: 'Archivist',
                actionType: 'entry_archived',
                agentId: 'archivist',
                source: 'internal',
                entityType: entry.entityType,
                entityId: entry.entityId,
                key: entry.key,
                reason: `Confidence below threshold (${entry.confidence} < ${LOW_CONFIDENCE_THRESHOLD})`,
                level: 'audit',
                metadata: {
                    archivedReason: 'low_confidence',
                    archivedFactId: String(entry.id),
                },
            });
            report.lowConfidenceArchived++;
        } catch (err) {
            report.errors.push(`Failed to archive low confidence entry ${entry.id}: ${err}`);
        }
    }
}

async function applyMemoryDecay(report: ArchivistReport): Promise<void> {
    const decayConfig = getDecayConfig();
    if (!decayConfig.enabled) {
        return;
    }

    const now = new Date();
    const candidates = await getDb().knowledgeEntry.findMany({
        where: {
            isProtected: false,
            confidence: { gt: 0 },
        },
    });

    for (const entry of candidates) {
        if (entry.valueSummary === '[ARCHIVED]') {
            continue;
        }

        const lastAccessedAt = entry.lastAccessedAt ?? entry.updatedAt ?? entry.createdAt;
        const timeSinceAccessDays = Math.max(0, (now.getTime() - lastAccessedAt.getTime()) / 86_400_000);
        const newConfidence = calculateDecayedConfidence(
            readOriginalConfidence(entry.properties, entry.confidence),
            timeSinceAccessDays,
            entry.stability
        );

        try {
            if (newConfidence < decayConfig.threshold) {
                await archiveEntry(entry, ArchivedReason.expired);
                getStaffEventEmitter().emit({
                    staffComponent: 'Archivist',
                    actionType: 'entry_decayed',
                    agentId: 'archivist',
                    source: 'internal',
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    key: entry.key,
                    reason: `Confidence decayed to ${newConfidence} — below threshold.`,
                    level: 'audit',
                    metadata: {
                        archivedReason: 'decay',
                        archivedFactId: String(entry.id),
                        decayPolicy: 'confidence_threshold',
                        newConfidence,
                    },
                });
                report.lowConfidenceArchived++;
                continue;
            }

            if (newConfidence !== entry.confidence) {
                await getDb().knowledgeEntry.update({
                    where: { id: entry.id },
                    data: { confidence: newConfidence },
                });
            }
        } catch (err) {
            report.errors.push(`Failed to apply decay to entry ${entry.id}: ${err}`);
        }
    }
}

// ─── Escalation Processing ───────────────────────────────────────────────────

async function processEscalations(report: ArchivistReport): Promise<void> {
    const paths = await ensureEscalationFolders();
    let files: string[];

    try {
        files = await fs.readdir(paths.active);
    } catch (err) {
        report.errors.push(`Could not read ${paths.active}: ${err}`);
        return;
    }

    const markdownFiles = files.filter((f) => f.endsWith('.md'));

    for (const filename of markdownFiles) {
        try {
            await processEscalationFile(filename, paths, report);
        } catch (err) {
            report.errors.push(`Failed to process escalation file ${filename}: ${err}`);
        }
    }
}

async function processEscalationFile(
    filename: string,
    paths: { active: string; resolved: string; archived: string },
    report: ArchivistReport
): Promise<void> {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(paths.active, sanitizedFilename);
    const content = await fs.readFile(filePath, 'utf-8');

    if (!content.includes('**Status:** RESOLVED')) {
        return;
    }

    let auth: AuthoritativeResolution;
    try {
        auth = extractAuthoritativeJson(content);
    } catch (err) {
        report.errors.push(`Escalation ${filename}: ${err}`);
        return;
    }

    const pending = await findPendingEscalation({
        entityType: auth.entityType,
        entityId: auth.entityId,
        key: auth.key,
    });

    if (!pending) {
        throw new Error(`No pending escalated archive row found for ${auth.entityType}/${auth.entityId}/${auth.key}.`);
    }

    const resolutionTs = new Date();
    const originalRetained =
        JSON.stringify(pending.valueRaw) === JSON.stringify(auth.value) &&
        pending.valueSummary === auth.summary;

    await getDb().$transaction(async (tx: TransactionClient) => {
        await tx.archive.update({
            where: { id: pending.id },
            data: {
                validUntil: resolutionTs,
                resolutionState: ResolutionState.resolved,
                resolutionOutcome: originalRetained
                    ? ResolutionOutcome.original_retained
                    : ResolutionOutcome.challenger_won,
            },
        });

        if (originalRetained) {
            await createEntry({
                entityType: pending.entityType,
                entityId: pending.entityId,
                key: pending.key,
                valueRaw: pending.valueRaw,
                valueSummary: pending.valueSummary,
                confidence: pending.confidence,
                source: pending.source,
                createdBy: pending.createdBy,
                validFrom: resolutionTs,
                validUntil: null,
                conflictLog: (pending.conflictLog as unknown as never[]) ?? [],
            }, tx);
        } else {
            await createEntry({
                entityType: auth.entityType,
                entityId: auth.entityId,
                key: auth.key,
                valueRaw: auth.value,
                valueSummary: auth.summary,
                confidence: 100,
                source: 'HumanReview',
                createdBy: 'archivist',
                validFrom: resolutionTs,
                validUntil: null,
                conflictLog: [{
                    detectedAt: new Date().toISOString(),
                    incomingSource: 'HumanReview',
                    incomingConfidence: 100,
                    existingConfidence: pending.confidence,
                    resolution: 'human_resolved',
                    resolvedBy: 'archivist',
                    notes: `Applied from escalation file: ${filename}`,
                }] as unknown as never[],
            }, tx);
        }
    });

    getStaffEventEmitter().emit({
        staffComponent: 'Archivist',
        actionType: 'escalation_processed',
        agentId: 'archivist',
        source: 'internal',
        entityType: auth.entityType,
        entityId: auth.entityId,
        key: auth.key,
        reason: 'Archivist consumed a Resolutionist resolution from escalation file.',
        level: 'audit',
        metadata: {
            escalationId: filename,
            winnerSource: originalRetained ? 'existing' : 'challenger',
        },
    });

    getStaffEventEmitter().emit({
        staffComponent: 'Archivist',
        actionType: 'resolution_consumed',
        agentId: 'archivist',
        source: 'internal',
        entityType: auth.entityType,
        entityId: auth.entityId,
        key: auth.key,
        reason: 'Archive row resolutionState set to resolved.',
        level: 'audit',
        metadata: {
            escalationId: filename,
            archiveEntryId: String(pending.id),
        },
    });

    // LLM enrichment (non-authoritative)
    try {
        const enrichment = await generateEnrichment(content, auth);
        if (enrichment) {
            await appendEnrichmentToFile(filePath, enrichment);
        }
    } catch (err) {
        // Enrichment failure doesn't block commit
        report.errors.push(`Escalation ${filename}: enrichment failed: ${err}`);
    }

    // Move file to resolved folder
    const resolvedPath = path.join(paths.resolved, sanitizedFilename);
    await fs.rename(filePath, resolvedPath);

    // Archive a copy with timestamp
    const archivedFilename = sanitizedFilename.replace('.md', `_archived_${Date.now()}.md`);
    const archivedPath = path.join(paths.archived, archivedFilename);
    await fs.copyFile(resolvedPath, archivedPath);

    report.escalationsProcessed++;
}

// ─── LLM Enrichment (Non-Authoritative) ─────────────────────────────────────

type Enrichment = {
    explanation: string;
    suggestedValidUntil?: string;
    normalizationWarnings?: string[];
};

async function generateEnrichment(
    fileContent: string,
    auth: AuthoritativeResolution
): Promise<Enrichment | null> {
    const prompt = `You are analyzing a resolved conflict. The human provided this authoritative resolution:

${JSON.stringify(auth, null, 2)}

Provide enrichment (non-authoritative):
1. Brief explanation of why this resolution makes sense
2. Suggested validUntil (ISO 8601) if none provided and fact seems time-bound
3. Any normalization warnings

Respond with JSON: { "explanation": "...", "suggestedValidUntil": "..." or null, "normalizationWarnings": [...] }`;

    const response = await complete([
        { role: 'user', content: prompt }
    ], 1000);
    try {
        return JSON.parse(response.text);
    } catch {
        return null;
    }
}

async function appendEnrichmentToFile(
    filePath: string,
    enrichment: Enrichment
): Promise<void> {
    const enrichmentBlock = `\n\n### LLM_ENRICHMENT (non-authoritative)\n\`\`\`json\n${JSON.stringify(enrichment, null, 2)}\n\`\`\`\n`;
    await fs.appendFile(filePath, enrichmentBlock);
}
