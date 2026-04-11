/**
 * Database client singleton for iranti.
 *
 * Wraps Prisma + pg with a module-level singleton so the entire process shares
 * one connection pool. The singleton is intentionally strict: calling `initDb`
 * a second time with different credentials throws rather than silently replacing
 * the pool, preventing the class of bugs where two callers race to initialise
 * with different parameters.
 *
 * Connection configuration (via `InitDbOptions`):
 *  - `applicationName` — sets `application_name` on the pg pool (visible in
 *    `pg_stat_activity`; useful for distinguishing iranti vs. control-plane)
 *  - `max` — pool size (default 10)
 *
 * Lifecycle:
 *  - `initDb(url, opts)` — create pool + Prisma client; idempotent for same URL
 *  - `getDb()`           — get the live client; throws if not yet initialised
 *  - `disconnectDb()`    — shut down LISTEN/NOTIFY listener, disconnect Prisma,
 *                          drain the pool
 *  - `getDbConnectionString()` — returns the URL used at init (for logging)
 *  - `prisma` alias      — legacy re-export of `getDb`, kept for compat
 */

import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

let pool: Pool | null = null;
let prisma: PrismaClient | null = null;
let initializedUrl: string | null = null;
let initializedApplicationName: string | null = null;

type InitDbOptions = {
    applicationName?: string;
    max?: number;
};

export function initDb(connectionString: string, options: InitDbOptions = {}): PrismaClient {
    const applicationName = options.applicationName?.trim() || null;

    if (prisma && initializedUrl === connectionString && initializedApplicationName === applicationName) {
        return prisma;
    }

    if (prisma && (initializedUrl !== connectionString || initializedApplicationName !== applicationName)) {
        throw new Error('DB already initialized with different connection string or application name.');
    }

    pool = new Pool({
        connectionString,
        ...(applicationName ? { application_name: applicationName } : {}),
        max: options.max ?? 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
        console.error('[prisma] Unexpected pool error:', err);
    });

    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    initializedUrl = connectionString;
    initializedApplicationName = applicationName;

    return prisma;
}

export function getDb(): PrismaClient {
    if (!prisma) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return prisma;
}

export function getDbConnectionString(): string | null {
    return initializedUrl;
}

export async function disconnectDb(): Promise<void> {
    const { shutdownSharedStateInvalidationListener } = require('../lib/sharedStateInvalidation') as {
        shutdownSharedStateInvalidationListener?: () => Promise<void>;
    };
    if (typeof shutdownSharedStateInvalidationListener === 'function') {
        await shutdownSharedStateInvalidationListener();
    }

    const currentPrisma = prisma;
    const currentPool = pool;

    prisma = null;
    pool = null;
    initializedUrl = null;
    initializedApplicationName = null;

    if (currentPrisma) {
        await currentPrisma.$disconnect();
    }

    if (currentPool) {
        await currentPool.end();
    }
}

// Legacy export for backward compatibility during migration
export { getDb as prisma };
