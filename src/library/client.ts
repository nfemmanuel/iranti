import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

let pool: Pool | null = null;
let prisma: PrismaClient | null = null;
let initializedUrl: string | null = null;

export function initDb(connectionString: string): PrismaClient {
    if (prisma && initializedUrl === connectionString) {
        return prisma;
    }

    if (prisma && initializedUrl !== connectionString) {
        throw new Error('DB already initialized with different connection string.');
    }

    pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 0,
    });

    pool.on('error', (err) => {
        console.error('[prisma] Unexpected pool error:', err);
    });

    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    initializedUrl = connectionString;

    return prisma;
}

export function getDb(): PrismaClient {
    if (!prisma) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return prisma;
}

// Legacy export for backward compatibility during migration
export { getDb as prisma };