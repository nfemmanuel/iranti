import 'dotenv/config';
import path from 'path';
import { initDb } from '../src/library/client';

type HarnessOptions = {
    requireDb?: boolean;
    forceLocalEscalationDir?: boolean;
};

const initialized = new Set<string>();

export function bootstrapHarness(options: HarnessOptions = {}): void {
    const {
        requireDb = true,
        forceLocalEscalationDir = true,
    } = options;

    if (forceLocalEscalationDir && !process.env.IRANTI_ESCALATION_DIR) {
        process.env.IRANTI_ESCALATION_DIR = path.resolve(process.cwd(), 'escalation');
    }

    if (!requireDb) return;

    const dbUrl = process.env.DATABASE_URL?.trim();
    if (!dbUrl) {
        throw new Error(
            'DATABASE_URL is required for test harness scripts. ' +
            'Set it in .env or shell environment.'
        );
    }

    if (initialized.has(dbUrl)) return;
    initDb(dbUrl);
    initialized.add(dbUrl);
}

export function errorMatches(err: unknown, patterns: RegExp[]): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return patterns.some((pattern) => pattern.test(message));
}
