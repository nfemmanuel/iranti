import { Router, Request, Response } from 'express';
import { Iranti } from '../../sdk';
import { addAlias, listAliases, parseEntityString, resolveEntity } from '../../library/entity-resolution';
import { validateInput } from '../middleware/validation';

function heuristicEntityId(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function toProjectStyleEntityId(name: string): string {
    const normalized = heuristicEntityId(name);
    if (!normalized) return '';
    return normalized.startsWith('project_') ? normalized : `project_${normalized}`;
}

function parseResolveTarget(entity: unknown): { entityType: string; entityId: string; rawName: string } {
    if (typeof entity !== 'string' || entity.trim().length === 0) {
        throw new Error('entity must be a non-empty string.');
    }

    const raw = entity.trim();
    if (raw.includes('/')) {
        const parsed = parseEntityString(raw);
        return {
            entityType: parsed.entityType,
            entityId: parsed.entityId,
            rawName: raw,
        };
    }

    const entityId = toProjectStyleEntityId(raw);
    if (!entityId) {
        throw new Error(`Unable to resolve raw entity name: "${raw}"`);
    }

    return {
        entityType: 'project',
        entityId,
        rawName: raw,
    };
}

export function knowledgeRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /write
    router.post('/write', validateInput('write'), async (req: Request, res: Response) => {
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

    // POST /resolve
    router.post('/resolve', async (req: Request, res: Response) => {
        try {
            const { entity, createIfMissing, aliases, source, confidence, agent } = req.body ?? {};
            const parsed = parseResolveTarget(entity);
            const resolved = await resolveEntity({
                entityType: parsed.entityType,
                entityId: parsed.entityId,
                rawName: parsed.rawName,
                aliases: Array.isArray(aliases) ? aliases : [parsed.rawName],
                source: source ?? agent ?? 'api',
                confidence: typeof confidence === 'number' ? confidence : undefined,
                createIfMissing: createIfMissing !== false,
            });

            res.json({
                canonicalEntity: resolved.canonicalEntity,
                canonicalType: resolved.entityType,
                canonicalId: resolved.entityId,
                addedAliases: resolved.addedAliases,
                matchedBy: resolved.matchedBy,
                entityKey: resolved.canonicalEntity,
            });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /alias
    router.post('/alias', async (req: Request, res: Response) => {
        try {
            const { canonicalEntity, alias, source, confidence, force } = req.body ?? {};
            const result = await addAlias({
                canonicalEntity,
                alias,
                source: source ?? 'api',
                confidence: typeof confidence === 'number' ? confidence : undefined,
                force: Boolean(force),
            });

            res.json({
                ok: true,
                canonicalEntity: result.canonicalEntity,
                aliasNormalized: result.aliasNormalized,
                created: result.created,
            });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /entity/:entityType/:entityId/aliases
    router.get('/entity/:entityType/:entityId/aliases', async (req: Request, res: Response) => {
        try {
            const { entityType, entityId } = req.params;
            const result = await listAliases(`${entityType}/${entityId}`);
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
    router.post('/relate', validateInput('relate'), async (req: Request, res: Response) => {
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
