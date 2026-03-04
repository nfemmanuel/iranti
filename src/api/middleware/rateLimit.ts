/**
 * Rate Limiting Middleware
 * Prevents API abuse by limiting requests per identity.
 * Uses authenticated keyId when available, otherwise request IP.
 */
import { NextFunction, Request, Response } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 100) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    
    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  check(apiKey: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.limits.get(apiKey);

    if (!entry || now > entry.resetAt) {
      // New window
      const resetAt = now + this.windowMs;
      this.limits.set(apiKey, { count: 1, resetAt });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt };
    }

    if (entry.count >= this.maxRequests) {
      // Rate limit exceeded
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }

    // Increment count
    entry.count++;
    this.limits.set(apiKey, entry);
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

// Export singleton instance
export const rateLimiter = new RateLimiter(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100')
);

function getRequestIdentity(req: Request): string {
  const auth = (req as any).irantiAuth;
  if (auth?.keyId) {
    return `key:${String(auth.keyId).toLowerCase()}`;
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

// Express middleware
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const identity = getRequestIdentity(req);
  const result = rateLimiter.check(identity);

  // Add rate limit headers
  res.setHeader('X-RateLimit-Limit', rateLimiter.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', new Date(result.resetAt).toISOString());

  if (!result.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
    });
  }

  next();
}
