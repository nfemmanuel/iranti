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
