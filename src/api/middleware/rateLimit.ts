/**
 * Rate Limiting Middleware
 * Prevents API abuse by limiting requests per identity.
 * Uses authenticated keyId when available, otherwise request IP.
 *
 * Two backends are supported:
 *   - memory (default): in-process Map. Resets on restart; not shared across instances.
 *   - db: Postgres-backed via iranti_rate_limits table. Shared across all instances,
 *         survives restarts. Activate with IRANTI_RATE_LIMIT_BACKEND=db.
 */
import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';

interface CheckResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
}

interface RateLimiterBackend {
    check(identity: string): CheckResult | Promise<CheckResult>;
    readonly limit: number;
}

// ─── In-memory backend ────────────────────────────────────────────────────────

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

class InMemoryRateLimiter implements RateLimiterBackend {
    private limits: Map<string, RateLimitEntry> = new Map();
    private readonly windowMs: number;
    private readonly maxRequests: number;

    constructor(windowMs: number, maxRequests: number) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;

        // Cleanup old entries every minute
        setInterval(() => this.cleanup(), 60000);
    }

    check(identity: string): CheckResult {
        const now = Date.now();
        const entry = this.limits.get(identity);

        if (!entry || now > entry.resetAt) {
            const resetAt = now + this.windowMs;
            this.limits.set(identity, { count: 1, resetAt });
            return { allowed: true, remaining: this.maxRequests - 1, resetAt };
        }

        if (entry.count >= this.maxRequests) {
            return { allowed: false, remaining: 0, resetAt: entry.resetAt };
        }

        entry.count++;
        this.limits.set(identity, entry);
        return { allowed: true, remaining: this.maxRequests - entry.count, resetAt: entry.resetAt };
    }

    private cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.limits.entries()) {
            if (now > entry.resetAt) {
                this.limits.delete(key);
            }
        }
    }

    get limit(): number {
        return this.maxRequests;
    }
}

// ─── Postgres backend ─────────────────────────────────────────────────────────

class DatabaseRateLimiter implements RateLimiterBackend {
    private pool: Pool | null = null;
    private readonly windowMs: number;
    private readonly maxRequests: number;
    private tableReady = false;

    constructor(windowMs: number, maxRequests: number) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
    }

    private getPool(): Pool {
        if (!this.pool) {
            const connectionString = process.env.DATABASE_URL;
            if (!connectionString) throw new Error('DATABASE_URL not set');
            this.pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30000 });
            this.pool.on('error', (err) => console.error('[rateLimit] pool error:', err));
        }
        return this.pool;
    }

    private async ensureTable(): Promise<void> {
        if (this.tableReady) return;
        await this.getPool().query(`
            CREATE TABLE IF NOT EXISTS iranti_rate_limits (
                identity TEXT NOT NULL,
                window_start BIGINT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (identity, window_start)
            )
        `);
        this.tableReady = true;
        // Clean up stale windows every 5 minutes
        setInterval(() => void this.cleanup(), 5 * 60 * 1000);
    }

    private async cleanup(): Promise<void> {
        try {
            const cutoff = Date.now() - this.windowMs * 2;
            await this.getPool().query(
                'DELETE FROM iranti_rate_limits WHERE window_start < $1',
                [cutoff],
            );
        } catch {
            // Non-fatal
        }
    }

    async check(identity: string): Promise<CheckResult> {
        try {
            await this.ensureTable();
            const now = Date.now();
            const windowStart = now - (now % this.windowMs);
            const resetAt = windowStart + this.windowMs;

            const result = await this.getPool().query<{ count: string }>(
                `INSERT INTO iranti_rate_limits (identity, window_start, count)
                 VALUES ($1, $2, 1)
                 ON CONFLICT (identity, window_start)
                 DO UPDATE SET count = iranti_rate_limits.count + 1
                 RETURNING count`,
                [identity, windowStart],
            );

            const count = Number(result.rows[0]?.count ?? 1);
            return {
                allowed: count <= this.maxRequests,
                remaining: Math.max(0, this.maxRequests - count),
                resetAt,
            };
        } catch (err) {
            // Fail open: if the DB is unavailable, don't block requests.
            console.error('[rateLimit] DB check failed, failing open:', err instanceof Error ? err.message : err);
            return { allowed: true, remaining: this.maxRequests, resetAt: Date.now() + this.windowMs };
        }
    }

    get limit(): number {
        return this.maxRequests;
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000');
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100');
const BACKEND = (process.env.IRANTI_RATE_LIMIT_BACKEND || 'memory').trim().toLowerCase();

export const rateLimiter: RateLimiterBackend = BACKEND === 'db'
    ? new DatabaseRateLimiter(WINDOW_MS, MAX_REQUESTS)
    : new InMemoryRateLimiter(WINDOW_MS, MAX_REQUESTS);

if (BACKEND === 'db') {
    console.log('[rateLimit] using Postgres-backed rate limiter (shared across instances)');
} else {
    console.log('[rateLimit] using in-memory rate limiter (per-instance, resets on restart)');
}

// ─── Identity ─────────────────────────────────────────────────────────────────

function getRequestIdentity(req: Request): string {
    const auth = req.irantiAuth;
    if (auth?.keyId) {
        return `key:${String(auth.keyId).toLowerCase()}`;
    }

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${ip}`;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const identity = getRequestIdentity(req);

    Promise.resolve(rateLimiter.check(identity))
        .then((result) => {
            res.setHeader('X-RateLimit-Limit', rateLimiter.limit);
            res.setHeader('X-RateLimit-Remaining', result.remaining);
            res.setHeader('X-RateLimit-Reset', new Date(result.resetAt).toISOString());

            if (!result.allowed) {
                return res.status(429).json({
                    error: 'Rate limit exceeded',
                    code: 'RATE_LIMIT_EXCEEDED',
                    retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
                });
            }

            next();
        })
        .catch((err) => {
            console.error('[rateLimit] unexpected error, failing open:', err);
            next();
        });
}
