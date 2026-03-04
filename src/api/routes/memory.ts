import { Router, Request, Response } from 'express';
import { Iranti } from '../../sdk';
import { parseEntityString } from '../../library/entity-resolution';
import { validateInput } from '../middleware/validation';

export function memoryRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /handshake
    router.post('/handshake', validateInput('handshake'), async (req: Request, res: Response) => {
        try {
            const result = await iranti.handshake(req.body);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /reconvene
    router.post('/reconvene', async (req: Request, res: Response) => {
        try {
            const { agentId, task, recentMessages } = req.body;
            const result = await iranti.reconvene(agentId, { task, recentMessages });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /whoknows/:entityType/:entityId
    router.get('/whoknows/:entityType/:entityId', async (req: Request, res: Response) => {
        try {
            const { entityType, entityId } = req.params;
            const result = await iranti.whoKnows(`${entityType}/${entityId}`);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /maintenance
    router.post('/maintenance', async (_req: Request, res: Response) => {
        try {
            const result = await iranti.runMaintenance();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /observe
    router.post('/observe', async (req: Request, res: Response) => {
        try {
            const { currentContext, maxFacts } = req.body;
            const agent = typeof req.body.agent === 'string' && req.body.agent.trim().length > 0
                ? req.body.agent
                : req.body.agentId;
            const rawEntityHints = req.body.entityHints;
            const normalizedContext = typeof currentContext === 'string' ? currentContext : '';
            const hasHintsField = rawEntityHints !== undefined;
            let entityHints: string[] = [];

            if (!agent || typeof agent !== 'string' || agent.trim().length === 0) {
                return res.status(400).json({ error: 'agent (or agentId) is required.' });
            }

            if (hasHintsField) {
                if (!Array.isArray(rawEntityHints)) {
                    return res.status(400).json({ error: 'entityHints must be an array of "entityType/entityId" strings.' });
                }
                const dedup = new Set<string>();
                for (const hint of rawEntityHints) {
                    if (typeof hint !== 'string') {
                        return res.status(400).json({
                            error: `Invalid entity hint: "${String(hint)}". Expected "entityType/entityId".`,
                        });
                    }
                    const normalized = hint.trim();
                    if (!normalized) continue;
                    if (!normalized.includes('/')) {
                        return res.status(400).json({
                            error: `Invalid entity hint: "${normalized}". Expected "entityType/entityId".`,
                        });
                    }
                    try {
                        parseEntityString(normalized);
                    } catch (err) {
                        return res.status(400).json({
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                    dedup.add(normalized);
                }
                entityHints = Array.from(dedup);
            }

            if (normalizedContext.trim().length === 0 && entityHints.length === 0) {
                return res.json({
                    facts: [],
                    entitiesDetected: [],
                    entitiesResolved: [],
                    alreadyPresent: 0,
                    totalFound: 0,
                    debug: {
                        skipped: 'empty_context',
                        contextLength: 0,
                        detectionWindowChars: 0,
                        detectedCandidates: 0,
                        keptCandidates: 0,
                        dropped: [],
                    },
                });
            }

            const result = await iranti.observe({
                agent,
                currentContext: normalizedContext,
                maxFacts,
                entityHints: entityHints.length > 0 ? entityHints : undefined,
            });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    return router;
}
