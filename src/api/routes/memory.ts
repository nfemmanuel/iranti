import { Router, Request, Response } from 'express';
import { Iranti } from '../../sdk';
import { parseEntityString } from '../../library/entity-resolution';
import { validateInput } from '../middleware/validation';

function normalizeAgent(req: Request): string | null {
    const fromAgent = req.body.agent;
    const fromAgentId = req.body.agentId;

    if (typeof fromAgentId === 'string' && fromAgentId.trim().length > 0) {
        return fromAgentId.trim();
    }
    if (typeof fromAgent === 'string' && fromAgent.trim().length > 0) {
        return fromAgent.trim();
    }

    return null;
}

function normalizeAgentFromBody(body: Record<string, unknown>): string | null {
    const fromAgent = body.agent;
    const fromAgentId = body.agentId;

    if (typeof fromAgentId === 'string' && fromAgentId.trim().length > 0) {
        return fromAgentId.trim();
    }
    if (typeof fromAgent === 'string' && fromAgent.trim().length > 0) {
        return fromAgent.trim();
    }

    return null;
}

function normalizeEntityHints(rawEntityHints: unknown): string[] {
    if (rawEntityHints === undefined) return [];
    if (!Array.isArray(rawEntityHints)) {
        throw new Error('entityHints must be an array of "entityType/entityId" strings.');
    }

    const dedup = new Set<string>();
    for (const hint of rawEntityHints) {
        if (typeof hint !== 'string') {
            throw new Error(`Invalid entity hint: "${String(hint)}". Expected "entityType/entityId".`);
        }
        const normalized = hint.trim();
        if (!normalized) continue;
        if (!normalized.includes('/')) {
            throw new Error(`Invalid entity hint: "${normalized}". Expected "entityType/entityId".`);
        }
        parseEntityString(normalized);
        dedup.add(normalized);
    }

    return Array.from(dedup);
}

export function memoryRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /handshake
    router.post('/handshake', validateInput('handshake'), async (req: Request, res: Response) => {
        try {
            const agentId = normalizeAgent(req);
            if (!agentId) {
                return res.status(400).json({ error: 'agentId is required (agent is accepted as a legacy alias).' });
            }
            const result = await iranti.handshake({
                agentId,
                task: req.body.task,
                recentMessages: req.body.recentMessages,
            });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /reconvene
    router.post('/reconvene', validateInput('reconvene'), async (req: Request, res: Response) => {
        try {
            const agentId = normalizeAgentFromBody(req.body as Record<string, unknown>);
            if (!agentId) {
                return res.status(400).json({ error: 'agentId is required (agent is accepted as a legacy alias).' });
            }
            const { task, recentMessages } = req.body;
            const result = await iranti.reconvene(agentId, { task, recentMessages });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /sessions
    router.get('/sessions', async (_req: Request, res: Response) => {
        try {
            const sessions = await iranti.listSessions();
            res.json(sessions);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /session/:agentId
    router.get('/session/:agentId', async (req: Request, res: Response) => {
        try {
            const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
            if (!agentId || !agentId.trim()) {
                return res.status(400).json({ error: 'agentId path parameter is required.' });
            }
            const sessionState = await iranti.inspectSession({ agentId: agentId.trim() });
            res.json(sessionState);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /checkpoint
    router.post('/checkpoint', validateInput('checkpoint'), async (req: Request, res: Response) => {
        try {
            const agentId = normalizeAgent(req);
            if (!agentId) {
                return res.status(400).json({ error: 'agentId is required (agent is accepted as a legacy alias).' });
            }
            const { task, recentMessages, checkpoint, sessionId, heartbeatAt } = req.body;
            const result = await iranti.checkpoint({
                agentId,
                task,
                recentMessages,
                checkpoint,
                sessionId,
                heartbeatAt,
            });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /resume
    router.post('/resume', validateInput('sessionAction'), async (req: Request, res: Response) => {
        try {
            const agentId = normalizeAgent(req);
            if (!agentId) {
                return res.status(400).json({ error: 'agentId is required (agent is accepted as a legacy alias).' });
            }
            const { sessionId } = req.body;
            const result = await iranti.resumeSession({ agentId, sessionId });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /complete
    router.post('/complete', validateInput('sessionAction'), async (req: Request, res: Response) => {
        try {
            const agentId = normalizeAgent(req);
            if (!agentId) {
                return res.status(400).json({ error: 'agentId is required (agent is accepted as a legacy alias).' });
            }
            const { sessionId } = req.body;
            const result = await iranti.completeSession({ agentId, sessionId });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /abandon
    router.post('/abandon', validateInput('sessionAction'), async (req: Request, res: Response) => {
        try {
            const agentId = normalizeAgent(req);
            if (!agentId) {
                return res.status(400).json({ error: 'agentId is required (agent is accepted as a legacy alias).' });
            }
            const { sessionId } = req.body;
            const result = await iranti.abandonSession({ agentId, sessionId });
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
    router.post('/observe', validateInput('observe'), async (req: Request, res: Response) => {
        try {
            const { currentContext, maxFacts } = req.body;
            const agent = normalizeAgent(req);
            const normalizedContext = typeof currentContext === 'string' ? currentContext : '';
            const entityHints = normalizeEntityHints(req.body.entityHints);

            if (!agent) {
                return res.status(400).json({ error: 'agent (or agentId) is required.' });
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

    // POST /attend
    router.post('/attend', validateInput('attend'), async (req: Request, res: Response) => {
        try {
            const { currentContext, maxFacts, latestMessage, forceInject } = req.body;
            const agent = normalizeAgent(req);
            const normalizedContext = typeof currentContext === 'string' ? currentContext : '';
            const normalizedLatestMessage = typeof latestMessage === 'string' ? latestMessage : undefined;
            const entityHints = normalizeEntityHints(req.body.entityHints);

            if (!agent) {
                return res.status(400).json({ error: 'agent (or agentId) is required.' });
            }

            const result = await iranti.attend({
                agent,
                currentContext: normalizedContext,
                maxFacts,
                entityHints: entityHints.length > 0 ? entityHints : undefined,
                latestMessage: normalizedLatestMessage,
                forceInject: forceInject === true,
            });
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    return router;
}
