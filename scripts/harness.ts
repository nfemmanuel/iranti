/**
 * Shared test bootstrap harness for iranti integration test scripts.
 *
 * Call bootstrapHarness() at the top of each test script to initialise the
 * DB connection and set IRANTI_ESCALATION_DIR to a local escalation/ path.
 * Exports: bootstrapHarness, ensureHarnessStaffEventsTable.
 */
import 'dotenv/config';
import path from 'path';
import { getDb, initDb } from '../src/library/client';
import { ensureStaffEventsTable as ensureSharedStaffEventsTable, resetStaffEventsTableBootstrap } from '../src/lib/staffEventsTable';

type HarnessOptions = {
    requireDb?: boolean;
    forceLocalEscalationDir?: boolean;
    dbApplicationName?: string;
};

const initialized = new Set<string>();
const staffEventsEnsured = new Set<string>();

export function bootstrapHarness(options: HarnessOptions = {}): void {
    const {
        requireDb = true,
        forceLocalEscalationDir = true,
        dbApplicationName,
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
    initDb(dbUrl, { applicationName: dbApplicationName });
    initialized.add(dbUrl);
}

export async function ensureHarnessStaffEventsTable(): Promise<void> {
    const dbUrl = process.env.DATABASE_URL?.trim();
    if (!dbUrl) {
        throw new Error(
            'DATABASE_URL is required to ensure the harness staff_events table. ' +
            'Set it in .env or shell environment.'
        );
    }

    if (!initialized.has(dbUrl)) {
        initDb(dbUrl);
        initialized.add(dbUrl);
    }
    if (staffEventsEnsured.has(dbUrl)) return;

    resetStaffEventsTableBootstrap();
    await ensureSharedStaffEventsTable();
    staffEventsEnsured.add(dbUrl);
}

export function errorMatches(err: unknown, patterns: RegExp[]): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return patterns.some((pattern) => pattern.test(message));
}
