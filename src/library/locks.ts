/**
 * Identity-level advisory locking for iranti knowledge writes.
 *
 * Provides `withIdentityLock(identity, fn)` — a two-layer concurrency guard
 * that ensures at most one write executes at a time for a given
 * `(entityType, entityId, key)` triple:
 *
 *  Layer 1 — in-process queue: a per-identity promise chain serialises
 *    concurrent callers within the same Node.js process. This avoids the
 *    overhead of acquiring a Postgres advisory lock when concurrency is local.
 *
 *  Layer 2 — Postgres advisory xact lock: `pg_advisory_xact_lock` acquired
 *    inside the Prisma transaction prevents races across multiple processes or
 *    replicas sharing the same database. The lock is automatically released
 *    when the transaction commits or rolls back.
 *
 * The lock key is a 63-bit FNV1a-derived bigint from the identity string.
 * If the transaction is aborted (e.g. due to a prior error in the same tx),
 * the lock is retried once before surfacing the error.
 */

import { getDb } from './client';
import type { PrismaClient } from '../generated/prisma/client';

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
const identityQueueTails = new Map<string, Promise<void>>();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function transactionBudget() {
    return {
        maxWait: parsePositiveInt(process.env.IRANTI_TX_MAX_WAIT_MS, 5_000),
        timeout: parsePositiveInt(process.env.IRANTI_TX_TIMEOUT_MS, 15_000),
    };
}

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
    return prisma.$transaction(async (tx: TransactionClient) => {
        const lockKey = hashToBigInt(`${identity.entityType}||${identity.entityId}||${identity.key}`);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
        return fn(tx);
    }, transactionBudget());
}

function identityQueueKey(identity: { entityType: string; entityId: string; key: string }): string {
    return `${identity.entityType}||${identity.entityId}||${identity.key}`;
}

async function withInProcessIdentityQueue<T>(
    identity: { entityType: string; entityId: string; key: string },
    fn: () => Promise<T>
): Promise<T> {
    const queueKey = identityQueueKey(identity);
    const previous = identityQueueTails.get(queueKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    identityQueueTails.set(queueKey, current);

    try {
        if (previous) {
            await previous;
        }
        return await fn();
    } finally {
        release();
        if (identityQueueTails.get(queueKey) === current) {
            identityQueueTails.delete(queueKey);
        }
    }
}

export async function withIdentityLock<T>(
    identity: { entityType: string; entityId: string; key: string },
    fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
    return withInProcessIdentityQueue(identity, async () => {
        try {
            return await executeWithIdentityLock(identity, fn);
        } catch (err) {
            if (!isAbortedTransactionError(err)) {
                throw err;
            }
            return executeWithIdentityLock(identity, fn);
        }
    });
}

function hashToBigInt(s: string): bigint {
    let hash = 1469598103934665603n;
    const prime = 1099511628211n;
    for (let i = 0; i < s.length; i++) {
        hash ^= BigInt(s.charCodeAt(i));
        hash = (hash * prime) & ((1n << 63n) - 1n);
    }
    return hash;
}
