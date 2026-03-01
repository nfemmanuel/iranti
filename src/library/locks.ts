import { getDb } from './client';
import type { PrismaClient } from '../generated/prisma/client';

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export async function withIdentityLock<T>(
    identity: { entityType: string; entityId: string; key: string },
    fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
    const prisma = getDb();
    
    return prisma.$transaction(async (tx) => {
        const lockKey = hashToBigInt(`${identity.entityType}||${identity.entityId}||${identity.key}`);
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lockKey});`);
        return fn(tx);
    });
}

function hashToBigInt(s: string): string {
    let hash = 1469598103934665603n;
    const prime = 1099511628211n;
    for (let i = 0; i < s.length; i++) {
        hash ^= BigInt(s.charCodeAt(i));
        hash = (hash * prime) & ((1n << 63n) - 1n);
    }
    return hash.toString();
}
