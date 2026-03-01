import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

let pool: Pool | null = null;
let prismaInstance: PrismaClient | null = null;

function getPool(): Pool {
    if (!pool) {
        pool = new Pool({ 
            connectionString: process.env.DATABASE_URL!,
            max: 10,
            idleTimeoutMillis: 0,
            connectionTimeoutMillis: 0,
        });
        pool.on('error', (err) => {
            console.error('[prisma] Unexpected pool error:', err);
        });
    }
    return pool;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = new Proxy({} as PrismaClient, {
    get(_target, prop) {
        if (!prismaInstance) {
            const adapter = new PrismaPg(getPool());
            prismaInstance = globalForPrisma.prisma ?? new PrismaClient({ adapter });
            if (process.env.NODE_ENV !== 'production') {
                globalForPrisma.prisma = prismaInstance;
            }
        }
        return (prismaInstance as any)[prop];
    }
});

// Connection will be established lazily on first query