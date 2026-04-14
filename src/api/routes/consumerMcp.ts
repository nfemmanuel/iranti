/**
 * Consumer MCP route — `/mcp/:token`
 *
 * Serves a simplified, user-scoped Model Context Protocol tool surface for
 * Claude.ai, ChatGPT, and other MCP-compatible AI frontends.
 *
 * Authentication: the raw token is extracted from the URL path, hashed with
 * SHA256+pepper, and looked up in the `tokens` table. A missing, revoked, or
 * wrong-scope token returns 401 before any MCP handshake begins.
 *
 * Tool surface (scope mcp_consumer_t0):
 *  - iranti_remember  — store a personal memory
 *  - iranti_recall    — retrieve a personal memory
 *  - iranti_forget    — delete a personal memory
 *
 * Transport: MCP Streamable HTTP (stateless — one transport per request).
 * Supports both POST (tool calls) and GET (SSE event stream) on the same path,
 * as required by the MCP spec.
 *
 * All reads and writes are scoped to the `userId` resolved from the token, so
 * no cross-user data leakage is possible at the query layer.
 */

import { Router, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { getDb } from '../../library/client';
import { hashApiKeySecret } from '../../security/apiKeys';
import { Prisma } from '../../generated/prisma/client';

export function consumerMcpRoutes(): Router {
  const router = Router();

  // Handle both GET (SSE) and POST (tool calls) on the same path
  router.all('/:token', async (req: Request, res: Response): Promise<void> => {
    const rawToken = Array.isArray(req.params['token']) ? req.params['token'][0] : req.params['token'];
    if (!rawToken) {
      res.status(401).json({ error: 'Missing token' });
      return;
    }

    const db = getDb();

    // ── Token authentication ──────────────────────────────────────────────────
    const tokenHash = hashApiKeySecret(rawToken);
    const tokenRecord = await db.token.findUnique({ where: { tokenHash } });

    if (!tokenRecord || tokenRecord.revokedAt !== null) {
      res.status(401).json({ error: 'Invalid or revoked token' });
      return;
    }

    // Consumer endpoint only serves mcp_consumer_* scopes
    if (!tokenRecord.scope.startsWith('mcp_consumer')) {
      res.status(403).json({ error: 'Token scope does not permit MCP consumer access' });
      return;
    }

    const userId = tokenRecord.userId;

    // Fire-and-forget lastUsedAt update (non-blocking)
    db.token.update({ where: { tokenHash }, data: { lastUsedAt: new Date() } }).catch(() => {});

    // ── MCP server setup (stateless — one per request) ────────────────────────
    const mcpServer = new McpServer({
      name: 'iranti',
      version: '1.0.0',
    });

    // iranti_remember — store a personal memory
    mcpServer.tool(
      'iranti_remember',
      'Store a personal memory in your Iranti knowledge base.',
      {
        entity: z.string().describe('Entity identifier. Use "person/me" for personal facts.'),
        key: z.string().describe('Fact key — a stable identifier for this memory (e.g. "dietary_preference")'),
        value: z.string().describe('The fact value to remember'),
        summary: z.string().optional().describe('Short human-readable summary (auto-derived from value if omitted)'),
      },
      async ({ entity, key, value, summary }) => {
        const [entityType, ...rest] = entity.split('/');
        const entityId = rest.join('/') || 'me';

        const valueSummary = summary ?? value.slice(0, 120);
        const valueRaw = { text: value } satisfies Prisma.InputJsonValue;

        await db.knowledgeEntry.upsert({
          where: {
            userId_entityType_entityId_key: { userId, entityType, entityId, key },
          },
          update: {
            valueRaw,
            valueSummary,
            source: `mcp_consumer`,
            updatedAt: new Date(),
            lastAccessedAt: new Date(),
          },
          create: {
            userId,
            entityType,
            entityId,
            key,
            valueRaw,
            valueSummary,
            confidence: 80,
            source: `mcp_consumer`,
            createdBy: `user/${userId}`,
            surface: tokenRecord.surface,
            conflictLog: [],
          },
        });

        return {
          content: [{ type: 'text' as const, text: `Remembered: ${entity}/${key} = "${valueSummary}"` }],
        };
      }
    );

    // iranti_recall — retrieve a personal memory
    mcpServer.tool(
      'iranti_recall',
      'Retrieve a personal memory from your Iranti knowledge base.',
      {
        entity: z.string().describe('Entity identifier (e.g. "person/me")'),
        key: z.string().describe('Fact key to retrieve'),
      },
      async ({ entity, key }) => {
        const [entityType, ...rest] = entity.split('/');
        const entityId = rest.join('/') || 'me';

        const entry = await db.knowledgeEntry.findUnique({
          where: {
            userId_entityType_entityId_key: { userId, entityType, entityId, key },
          },
        });

        if (!entry) {
          return {
            content: [{ type: 'text' as const, text: `No memory found for ${entity}/${key}` }],
          };
        }

        // Update access timestamp
        db.knowledgeEntry.update({
          where: { userId_entityType_entityId_key: { userId, entityType, entityId, key } },
          data: { lastAccessedAt: new Date() },
        }).catch(() => {});

        const valueText = typeof entry.valueRaw === 'string'
          ? entry.valueRaw
          : (entry.valueRaw as { text?: string })?.text ?? JSON.stringify(entry.valueRaw);

        return {
          content: [{ type: 'text' as const, text: `${entry.valueSummary}\n\n${valueText}` }],
        };
      }
    );

    // iranti_forget — delete a personal memory
    mcpServer.tool(
      'iranti_forget',
      'Delete a personal memory from your Iranti knowledge base.',
      {
        entity: z.string().describe('Entity identifier (e.g. "person/me")'),
        key: z.string().describe('Fact key to forget'),
      },
      async ({ entity, key }) => {
        const [entityType, ...rest] = entity.split('/');
        const entityId = rest.join('/') || 'me';

        const deleted = await db.knowledgeEntry.deleteMany({
          where: { userId, entityType, entityId, key },
        });

        if (deleted.count === 0) {
          return {
            content: [{ type: 'text' as const, text: `No memory found for ${entity}/${key} — nothing to forget.` }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Forgotten: ${entity}/${key}` }],
        };
      }
    );

    // ── Stateless transport (one per request) ─────────────────────────────────
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await mcpServer.close();
    }
  });

  return router;
}
