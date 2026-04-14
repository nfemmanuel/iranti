/**
 * Token management routes — `/tokens`
 *
 * Exposes CRUD for consumer MCP tokens. Requires standard API-key auth
 * (`authenticate` middleware). All operations are scoped to the `userId`
 * resolved from `req.irantiAuth.userId` — callers only see their own tokens.
 *
 * Routes:
 *   POST   /tokens          — mint a new consumer MCP token
 *   GET    /tokens          — list tokens for the current user
 *   DELETE /tokens/:id      — revoke a token by id
 *
 * Response for POST includes `mcpUrl` — the full URL to paste into Claude.ai
 * or ChatGPT as an MCP connector. The `rawSecret` field is shown once only.
 */

import { Router, Request, Response } from 'express';
import {
    createConsumerToken,
    revokeConsumerToken,
    listConsumerTokens,
} from '../../security/consumerTokens';
import { Surface } from '../../generated/prisma/client';

export const tokensRouter: Router = Router();

/**
 * POST /tokens
 * Body: { surface?: 'claude' | 'chatgpt' | 'gemini' | ... }
 * Returns: { id, mcpUrl, rawSecret, scope, surface, createdAt }
 */
tokensRouter.post('/', async (req: Request, res: Response): Promise<void> => {
    const userId = req.irantiAuth?.userId ?? 1;
    const surfaceRaw = (req.body as { surface?: string })?.surface;

    // Validate surface or default to claude
    const validSurfaces = Object.values(Surface);
    const surface: Surface = (validSurfaces.includes(surfaceRaw as Surface)
        ? (surfaceRaw as Surface)
        : Surface.claude);

    try {
        const { rawSecret, mcpUrl, record } = await createConsumerToken({ userId, surface });

        res.status(201).json({
            id: record.id,
            rawSecret,
            mcpUrl,
            scope: record.scope,
            surface: record.surface,
            createdAt: record.createdAt,
        });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Token creation failed' });
    }
});

/**
 * GET /tokens
 * Returns: { tokens: ConsumerTokenRecord[] }
 */
tokensRouter.get('/', async (req: Request, res: Response): Promise<void> => {
    const userId = req.irantiAuth?.userId ?? 1;

    try {
        const tokens = await listConsumerTokens(userId);
        res.json({ tokens });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list tokens' });
    }
});

/**
 * DELETE /tokens/:id
 * Returns: { revoked: boolean }
 */
tokensRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const userId = req.irantiAuth?.userId ?? 1;
    const idRaw = Array.isArray(req.params['id']) ? req.params['id'][0] : req.params['id'];
    const id = Number.parseInt(idRaw ?? '', 10);

    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid token id' });
        return;
    }

    try {
        const revoked = await revokeConsumerToken(id, userId);
        if (!revoked) {
            res.status(404).json({ error: 'Token not found or does not belong to you' });
            return;
        }
        res.json({ revoked: true });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to revoke token' });
    }
});
