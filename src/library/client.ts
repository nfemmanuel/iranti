import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL!,
    max: 10,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 0,
});

pool.on('error', (err) => {
    console.error('[prisma] Unexpected pool error:', err);
});

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
    globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

// Connection will be established lazily on first query