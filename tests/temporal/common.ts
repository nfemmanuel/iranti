import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { configureMock } from '../../src/lib/providers/mock';

const DEFAULT_VALIDATION_DATABASE_URL = 'postgresql://postgres:053435@localhost:5433/iranti_temporal';

let client: Iranti | null = null;

async function canReachDatabase(connectionString: string): Promise<boolean> {
    const pool = new Pool({
        connectionString,
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 2000,
    });

    try {
        const dbClient = await pool.connect();
        try {
            await dbClient.query('SELECT 1');
            return true;
        } finally {
            dbClient.release();
        }
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[temporal-tests] database probe failed for ${connectionString}: ${reason}`);
        return false;
    } finally {
        await pool.end().catch(() => undefined);
    }
}

export async function resolveTemporalDatabaseUrl(): Promise<string> {
    const primary = process.env.DATABASE_URL?.trim();
    const override = process.env.TEMPORAL_DATABASE_URL?.trim();
    const validation = override || process.env.IRANTI_VALIDATION_DATABASE_URL?.trim() || DEFAULT_VALIDATION_DATABASE_URL;

    if (primary && await canReachDatabase(primary)) {
        return primary;
    }

    if (await canReachDatabase(validation)) {
        process.env.DATABASE_URL = validation;
        return validation;
    }

    throw new Error(
        'Temporal tests could not reach either DATABASE_URL or the validation database. ' +
        `Checked: ${primary ?? '(unset)'} and ${validation}`
    );
}

export async function prepareTemporalTests(): Promise<{ iranti: Iranti; databaseUrl: string }> {
    const databaseUrl = await resolveTemporalDatabaseUrl();
    process.env.DATABASE_URL = databaseUrl;
    process.env.LLM_PROVIDER = 'mock';
    process.env.IRANTI_ESCALATION_DIR = path.resolve(process.cwd(), 'tests', 'temporal', '.runtime', 'escalation');
    await fs.mkdir(process.env.IRANTI_ESCALATION_DIR, { recursive: true });

    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: false });
    configureMock({
        scenario: 'default',
        seed: 42,
        failureRate: 0,
    });

    if (!client) {
        client = new Iranti({
            connectionString: databaseUrl,
            llmProvider: 'mock',
        });
    }

    return { iranti: client, databaseUrl };
}

export function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

export function makeTemporalEntity(base: string): string {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return `project/${base}_${suffix}`;
}
