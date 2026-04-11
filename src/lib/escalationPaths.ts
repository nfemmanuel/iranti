/**
 * Escalation directory path resolution for Iranti.
 *
 * Escalations are conflict cases where the Librarian cannot confidently
 * resolve a knowledge conflict and writes a file for human review.
 * The root directory defaults to ~/.iranti/escalation but can be overridden
 * via IRANTI_ESCALATION_DIR. Subdirectories follow a three-state lifecycle:
 *   active/    — pending human review
 *   resolved/  — resolution provided
 *   archived/  — closed/historical
 *
 * Key exports:
 *   - getEscalationPaths()      — compute path object without touching disk
 *   - ensureEscalationFolders() — mkdir all subdirs and return the path object
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export type EscalationPaths = {
    root: string;
    active: string;
    resolved: string;
    archived: string;
};

function resolveRootFromEnv(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

export function getEscalationPaths(): EscalationPaths {
    const fromEnv = process.env.IRANTI_ESCALATION_DIR;
    const root =
        fromEnv && fromEnv.trim().length > 0
            ? resolveRootFromEnv(fromEnv)
            : path.join(os.homedir(), '.iranti', 'escalation');

    return {
        root,
        active: path.join(root, 'active'),
        resolved: path.join(root, 'resolved'),
        archived: path.join(root, 'archived'),
    };
}

export async function ensureEscalationFolders(): Promise<EscalationPaths> {
    const paths = getEscalationPaths();
    await Promise.all([
        fs.mkdir(paths.active, { recursive: true }),
        fs.mkdir(paths.resolved, { recursive: true }),
        fs.mkdir(paths.archived, { recursive: true }),
    ]);
    return paths;
}
