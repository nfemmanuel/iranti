import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { initDb, disconnectDb } from '../../src/library/client';
import { Pool } from 'pg';
import {
    registerSharedStateInvalidationObserver,
    unregisterSharedStateInvalidationObserver,
} from '../../src/lib/sharedStateInvalidation';

const DEFAULT_VALIDATION_DATABASE_URL = 'postgresql://postgres:053435@localhost:5433/iranti_temporal';
const tsNodeTranspileOnlyRegister = require.resolve('ts-node/register/transpile-only');

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function canReachDatabase(connectionString: string): Promise<boolean> {
    const pool = new Pool({
        connectionString,
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 2000,
    });

    try {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
            return true;
        } finally {
            client.release();
        }
    } catch {
        return false;
    } finally {
        await pool.end().catch(() => undefined);
    }
}

async function resolveValidationDatabaseUrl(): Promise<string> {
    const candidates = [
        process.env.DATABASE_URL?.trim(),
        process.env.IRANTI_VALIDATION_DATABASE_URL?.trim(),
        DEFAULT_VALIDATION_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
        if (!await canReachDatabase(candidate)) continue;
        process.env.DATABASE_URL = candidate;
        return candidate;
    }

    throw new Error(`Cross-process invalidation tests could not find a reachable database. Checked: ${candidates.join(', ')}`);
}

async function main(): Promise<void> {
    const connectionString = await resolveValidationDatabaseUrl();

    initDb(connectionString, {
        applicationName: `cross_process_invalidation_${Date.now()}`,
    });

    const watchedEntity = `project/${uniqueId('cross_process_invalidation')}`;
    const received: Array<{ entity: string; key: string }> = [];
    const observerId = uniqueId('cross_process_observer');

    registerSharedStateInvalidationObserver(observerId, {
        isWatchingEntity(entity: string): boolean {
            return entity === watchedEntity;
        },
        notifySharedEntityUpdated(entity: string, key: string): void {
            received.push({ entity, key });
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const childScript = `
            const { initDb, disconnectDb } = require('./src/library/client');
            const { broadcastSharedEntityUpdated } = require('./src/lib/sharedStateInvalidation');
            (async () => {
              initDb(process.env.DATABASE_URL, { applicationName: 'cross_process_invalidation_writer' });
              await broadcastSharedEntityUpdated(process.argv[1], process.argv[2]);
              await disconnectDb();
            })().catch((error) => {
              console.error(error instanceof Error ? error.message : String(error));
              process.exit(1);
            });
        `;

        const child = spawnSync(
            process.execPath,
            ['-r', tsNodeTranspileOnlyRegister, '-e', childScript, watchedEntity, 'recent_file_changes'],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    DATABASE_URL: connectionString,
                    TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
                    TS_NODE_TRANSPILE_ONLY: 'true',
                    NO_COLOR: '1',
                },
                encoding: 'utf8',
            },
        );

        assert.equal(child.status, 0, `cross-process invalidation child failed:\n${child.stdout ?? ''}\n${child.stderr ?? ''}`);
        await waitFor(() => received.some((entry) => entry.entity === watchedEntity && entry.key === 'recent_file_changes'), 3000);
        assert.ok(
            received.some((entry) => entry.entity === watchedEntity && entry.key === 'recent_file_changes'),
            'Expected cross-process listener to receive the invalidation payload from the child process.',
        );

        console.log('cross-process invalidation tests passed');
    } finally {
        unregisterSharedStateInvalidationObserver(observerId);
        await disconnectDb();
    }
}

main().catch((error) => {
    console.error('cross-process invalidation tests failed:', error);
    process.exit(1);
});
