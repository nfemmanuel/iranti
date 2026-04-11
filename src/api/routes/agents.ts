/**
 * Agent registry REST routes for iranti (`/agents`).
 *
 *  POST /agents/register       — register or update an agent profile
 *  GET  /agents                — list all registered agent profiles
 *  GET  /agents/:agentId       — get profile + stats for one agent
 *  GET  /agents/:agentId/stats — alias for per-agent stats
 *  GET  /agents/:agentId/who-knows/:entityType/:entityId
 *                              — which agents contributed to an entity
 *  POST /agents/:agentId/team  — assign agent to a team (MEMBER_OF relationship)
 */

import { Router, Request, Response } from 'express';
import { Iranti } from '../../sdk';

export function agentRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /agents/register
    router.post('/register', async (req: Request, res: Response) => {
        try {
            await iranti.registerAgent(req.body);
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /agents
    router.get('/', async (_req: Request, res: Response) => {
        try {
            const result = await iranti.listAgents();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /agents/:agentId
    router.get('/:agentId', async (req: Request, res: Response) => {
        try {
            const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
            const result = await iranti.getAgent(agentId);
            if (!result) {
                res.status(404).json({ error: `Agent ${agentId} not found.` });
                return;
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /agents/:agentId/team
    router.post('/:agentId/team', async (req: Request, res: Response) => {
        try {
            const agentId = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
            const { teamId } = req.body;
            await iranti.assignToTeam(agentId, teamId);
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    return router;
}
