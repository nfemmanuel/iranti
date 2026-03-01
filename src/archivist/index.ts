import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../library/client';
import { archiveEntry } from '../library/queries';
import { complete } from '../lib/llm';

// ─── Constants ───────────────────────────────────────────────────────────────

const ESCALATION_ACTIVE = path.join(process.cwd(), 'escalation', 'active');
const ESCALATION_RESOLVED = path.join(process.cwd(), 'escalation', 'resolved');
const ESCALATION_ARCHIVED = path.join(process.cwd(), 'escalation', 'archived');
const LOW_CONFIDENCE_THRESHOLD = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArchivistReport {
    expiredArchived: number;
    lowConfidenceArchived: number;
    duplicatesMerged: number;
    escalationsProcessed: number;
    errors: string[];
}

// ─── Main Cycle ──────────────────────────────────────────────────────────────

async function ensureEscalationFolders(): Promise<void> {
    await Promise.all([
        fs.mkdir(ESCALATION_ACTIVE, { recursive: true }),
        fs.mkdir(ESCALATION_RESOLVED, { recursive: true }),
        fs.mkdir(ESCALATION_ARCHIVED, { recursive: true }),
    ]);
}

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
    const expired = await prisma.knowledgeEntry.findMany({
        where: {
            validUntil: { lt: new Date() },
            isProtected: false,
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
    const lowConfidence = await prisma.knowledgeEntry.findMany({
        where: {
            confidence: { lt: LOW_CONFIDENCE_THRESHOLD },
            isProtected: false,
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
    let files: string[];

    try {
        files = await fs.readdir(ESCALATION_ACTIVE);
    } catch (err) {
        report.errors.push(`Could not read escalation/active/: ${err}`);
        return;
    }

    const markdownFiles = files.filter((f) => f.endsWith('.md'));

    for (const filename of markdownFiles) {
        try {
            await processEscalationFile(filename, report);
        } catch (err) {
            report.errors.push(`Failed to process escalation file ${filename}: ${err}`);
        }
    }
}

async function processEscalationFile(
    filename: string,
    report: ArchivistReport
): Promise<void> {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(ESCALATION_ACTIVE, sanitizedFilename);
    const content = await fs.readFile(filePath, 'utf-8');

    // Only process RESOLVED files
    if (!content.includes('**Status:** RESOLVED')) {
        return;
    }

    // Extract human resolution section
    const humanResolutionMatch = content.split('## HUMAN RESOLUTION')[1];
    if (!humanResolutionMatch) return;

    // Strip HTML comments and whitespace
    const humanResolution = humanResolutionMatch
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();

    if (!humanResolution) return;

    // Extract entity info from the file
    const entityMatch = content.match(/\*\*Entity:\*\* (.+?) \/ (.+?) \/ (.+)/);
    if (!entityMatch) return;

    const [, entityType, entityId, key] = entityMatch;

    // P0: Parse deterministic JSON format (no LLM)
    let resolved: { value: unknown; summary: string };
    try {
        const jsonMatch = humanResolution.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            report.errors.push(`Escalation ${filename}: No JSON found in HUMAN RESOLUTION section`);
            return;
        }
        resolved = JSON.parse(jsonMatch[0]);
        if (!resolved.value || !resolved.summary) {
            report.errors.push(`Escalation ${filename}: JSON must have 'value' and 'summary' fields`);
            return;
        }
    } catch (err) {
        report.errors.push(`Escalation ${filename}: Invalid JSON in HUMAN RESOLUTION: ${err}`);
        return;
    }

    // P0: Route through Librarian instead of direct upsert
    const { librarianWrite } = await import('../librarian/index');
    await librarianWrite({
        entityType: entityType.trim(),
        entityId: entityId.trim(),
        key: key.trim(),
        valueRaw: resolved.value,
        valueSummary: resolved.summary,
        confidence: 100,
        source: 'HumanReview',
        createdBy: 'archivist',
    });

    // Move file to resolved folder
    const resolvedPath = path.join(ESCALATION_RESOLVED, sanitizedFilename);
    await fs.rename(filePath, resolvedPath);

    // Archive a copy with timestamp
    const archivedFilename = sanitizedFilename.replace('.md', `_archived_${Date.now()}.md`);
    const archivedPath = path.join(ESCALATION_ARCHIVED, archivedFilename);
    await fs.copyFile(resolvedPath, archivedPath);

    report.escalationsProcessed++;
}