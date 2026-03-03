import { getDb } from './client';
import type { PrismaClient } from '../generated/prisma/client';

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

function isAbortedTransactionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    return lower.includes('current transaction is aborted') || lower.includes('transaction is aborted');
}

async function executeWithIdentityLock<T>(
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

export async function withIdentityLock<T>(
    identity: { entityType: string; entityId: string; key: string },
    fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
    try {
        return await executeWithIdentityLock(identity, fn);
    } catch (err) {
        if (!isAbortedTransactionError(err)) {
            throw err;
        }
        return executeWithIdentityLock(identity, fn);
    }
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
