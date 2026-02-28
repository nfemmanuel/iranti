import { Router, Request, Response } from 'express';
import { Iranti } from '../../sdk';

export function knowledgeRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /write
    router.post('/write', async (req: Request, res: Response) => {
        try {
            const result = await iranti.write(req.body);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /ingest
    router.post('/ingest', async (req: Request, res: Response) => {
        try {
            const result = await iranti.ingest(req.body);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /query/:entityType/:entityId/:key
    router.get('/query/:entityType/:entityId/:key', async (req: Request, res: Response) => {
        try {
            const entityType = Array.isArray(req.params.entityType) ? req.params.entityType[0] : req.params.entityType;
            const entityId = Array.isArray(req.params.entityId) ? req.params.entityId[0] : req.params.entityId;
            const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
            const result = await iranti.query(`${entityType}/${entityId}`, key);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /query/:entityType/:entityId
    router.get('/query/:entityType/:entityId', async (req: Request, res: Response) => {
        try {
            const { entityType, entityId } = req.params;
            const result = await iranti.queryAll(`${entityType}/${entityId}`);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /relate
    router.post('/relate', async (req: Request, res: Response) => {
        try {
            const { fromEntity, relationshipType, toEntity, createdBy, properties } = req.body;
            await iranti.relate(fromEntity, relationshipType, toEntity, { createdBy, properties });
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /related/:entityType/:entityId
    router.get('/related/:entityType/:entityId', async (req: Request, res: Response) => {
        try {
            const { entityType, entityId } = req.params;
            const result = await iranti.getRelated(`${entityType}/${entityId}`);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /related/:entityType/:entityId/deep
    router.get('/related/:entityType/:entityId/deep', async (req: Request, res: Response) => {
        try {
            const { entityType, entityId } = req.params;
            const depth = parseInt(req.query.depth as string ?? '2');
            const result = await iranti.getRelatedDeep(`${entityType}/${entityId}`, depth);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    return router;
}
