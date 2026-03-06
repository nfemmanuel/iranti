import fs from 'fs/promises';
import path from 'path';
import { getDb } from '../library/client';
import { archiveEntry } from '../library/queries';
import { complete } from '../lib/llm';
import { ensureEscalationFolders } from '../lib/escalationPaths';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArchivistReport {
    expiredArchived: number;
    lowConfidenceArchived: number;
    duplicatesMerged: number;
    escalationsProcessed: number;
    errors: string[];
}

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
    await processEscalations(report);

    return report;
}

// ─── Expired Entries ─────────────────────────────────────────────────────────

async function archiveExpired(report: ArchivistReport): Promise<void> {
    const expired = await getDb().knowledgeEntry.findMany({
        where: {
            validUntil: { lt: new Date() },
            isProtected: false,
            confidence: { gt: 0 },
            valueSummary: { not: '[ARCHIVED]' },
        },
    });

    for (const entry of expired) {
        try {
            await archiveEntry(entry, 'expired');
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
            valueSummary: { not: '[ARCHIVED]' },
        },
    });

    for (const entry of lowConfidence) {
        try {
            await archiveEntry(entry, 'superseded');
            report.lowConfidenceArchived++;
        } catch (err) {
            report.errors.push(`Failed to archive low confidence entry ${entry.id}: ${err}`);
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

    const { librarianWrite } = await import('../librarian/index');
    const result = await librarianWrite({
        entityType: auth.entityType,
        entityId: auth.entityId,
        key: auth.key,
        valueRaw: auth.value,
        valueSummary: auth.summary,
        confidence: 100,
        source: 'HumanReview',
        createdBy: 'archivist',
        validUntil: auth.validUntil ? new Date(auth.validUntil) : undefined,
        conflictLog: [{
            detectedAt: new Date().toISOString(),
            incomingSource: 'HumanReview',
            incomingConfidence: 100,
            existingConfidence: 0,
            resolution: 'human_resolved',
            resolvedBy: 'archivist',
            notes: `Applied from escalation file: ${filename}`,
        }] as unknown as never,
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
