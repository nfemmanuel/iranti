import { Router, Request, Response } from 'express';
import { Iranti } from '../../sdk';

export function memoryRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /handshake
    router.post('/handshake', async (req: Request, res: Response) => {
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

    return router;
}
