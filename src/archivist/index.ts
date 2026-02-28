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

export async function runArchivist(): Promise<ArchivistReport> {
    const report: ArchivistReport = {
        expiredArchived: 0,
        lowConfidenceArchived: 0,
        duplicatesMerged: 0,
        escalationsProcessed: 0,
        errors: [],
    };

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
    } catch {
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
    const filePath = path.join(ESCALATION_ACTIVE, filename);
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

    // Use LLM to extract the resolved value from human resolution text
    const response = await complete([
        {
            role: 'user',
            content: `A human has resolved a knowledge conflict. Extract the authoritative value they decided on.

Human resolution text:
${humanResolution}

Return only a JSON object with two fields:
- "value": the resolved fact as a simple string or object
- "summary": one sentence summarizing the resolved value

Example: {"value": "MIT", "summary": "Researcher is affiliated with MIT"}`,
        },
    ], 256);

    let resolved: { value: unknown; summary: string };
    try {
        const clean = response.text.replace(/```json|```/g, '').trim();
        resolved = JSON.parse(clean);
    } catch {
        resolved = {
            value: humanResolution,
            summary: humanResolution.substring(0, 100),
        };
    }

    // Write authoritative entry to KB
    await prisma.knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: entityType.trim(),
                entityId: entityId.trim(),
                key: key.trim(),
            },
        },
        update: {
            valueRaw: resolved.value as never,
            valueSummary: resolved.summary,
            confidence: 100,
            source: 'HumanReview',
            updatedAt: new Date(),
        },
        create: {
            entityType: entityType.trim(),
            entityId: entityId.trim(),
            key: key.trim(),
            valueRaw: resolved.value as never,
            valueSummary: resolved.summary,
            confidence: 100,
            source: 'HumanReview',
            createdBy: 'archivist',
            conflictLog: [],
        },
    });

    // Move file to resolved folder
    const resolvedPath = path.join(ESCALATION_RESOLVED, filename);
    await fs.rename(filePath, resolvedPath);

    // Archive a copy with timestamp
    const archivedFilename = filename.replace('.md', `_archived_${Date.now()}.md`);
    const archivedPath = path.join(ESCALATION_ARCHIVED, archivedFilename);
    await fs.copyFile(resolvedPath, archivedPath);

    report.escalationsProcessed++;
}