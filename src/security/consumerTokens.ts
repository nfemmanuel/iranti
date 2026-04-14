/**
 * Consumer token management — mint, list, and revoke MCP consumer tokens.
 *
 * Consumer tokens are stored in the `tokens` table (not the knowledge_base
 * API key registry). Each token is a random base64url secret whose SHA256+pepper
 * hash is stored in `tokenHash`. The raw secret is returned only at mint time
 * and never stored — if lost, the user must revoke and mint a new token.
 *
 * Token format: a raw base64url string (no keyId prefix).
 * URL-embedded form: `https://api.iranti.dev/mcp/<rawSecret>`
 *
 * Scope is always `mcp_consumer_t0` for Tier 0 (URL-embedded, no OAuth).
 * Surface tracks which AI frontend the token was created for.
 */

import { getDb } from '../library/client';
import { generateApiKeySecret, hashApiKeySecret } from './apiKeys';
import { Surface, TokenScope } from '../generated/prisma/client';

export interface ConsumerTokenRecord {
    id: number;
    tokenHashPrefix: string; // first 8 chars — safe to display for identification
    userId: number;
    scope: TokenScope;
    surface: Surface;
    createdAt: Date;
    lastUsedAt: Date;
    revokedAt: Date | null;
}

/**
 * Mint a new consumer MCP token for a user.
 *
 * Returns the raw secret (shown once only) and the token record.
 * The full URL to use in Claude.ai / ChatGPT is:
 *   `https://api.iranti.dev/mcp/<rawSecret>`
 */
export async function createConsumerToken(input: {
    userId: number;
    surface: Surface;
    scope?: TokenScope;
}): Promise<{ rawSecret: string; record: ConsumerTokenRecord; mcpUrl: string }> {
    const db = getDb();
    const rawSecret = generateApiKeySecret(32);
    const tokenHash = hashApiKeySecret(rawSecret);
    const scope = input.scope ?? TokenScope.mcp_consumer_t0;

    const token = await db.token.create({
        data: {
            tokenHash,
            userId: input.userId,
            scope,
            surface: input.surface,
        },
    });

    const baseUrl = process.env.IRANTI_PUBLIC_URL?.trim() ?? 'https://api.iranti.dev';
    const mcpUrl = `${baseUrl}/mcp/${rawSecret}`;

    return {
        rawSecret,
        mcpUrl,
        record: {
            id: token.id,
            tokenHashPrefix: tokenHash.slice(0, 8),
            userId: token.userId,
            scope: token.scope,
            surface: token.surface,
            createdAt: token.createdAt,
            lastUsedAt: token.lastUsedAt,
            revokedAt: token.revokedAt,
        },
    };
}

/**
 * Revoke a consumer token by its database id.
 * Returns false if the token does not belong to userId (ownership check).
 */
export async function revokeConsumerToken(
    tokenId: number,
    userId: number
): Promise<boolean> {
    const db = getDb();

    const token = await db.token.findUnique({ where: { id: tokenId } });
    if (!token || token.userId !== userId) return false;
    if (token.revokedAt !== null) return true; // already revoked

    await db.token.update({
        where: { id: tokenId },
        data: { revokedAt: new Date() },
    });
    return true;
}

/**
 * List all consumer tokens for a user.
 * Never returns the raw secret — only the prefix hash for identification.
 */
export async function listConsumerTokens(userId: number): Promise<ConsumerTokenRecord[]> {
    const db = getDb();

    const tokens = await db.token.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
    });

    return tokens.map((t) => ({
        id: t.id,
        tokenHashPrefix: t.tokenHash.slice(0, 8),
        userId: t.userId,
        scope: t.scope,
        surface: t.surface,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
    }));
}
