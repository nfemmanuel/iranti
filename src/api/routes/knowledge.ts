/**
 * Knowledge base REST routes for iranti (`/kb`).
 *
 * Handles reads and writes to the knowledge store via the Iranti SDK.
 * All write routes go through the Librarian conflict resolution pipeline.
 * All read routes go through the Attendant observe/query layer.
 *
 * Key routes:
 *  POST /kb/write          — write a single knowledge entry
 *  POST /kb/ingest         — LLM-chunked ingest of raw text
 *  GET  /kb/query          — structured knowledge query (entity/key lookup)
 *  POST /kb/search         — hybrid lexical+vector search
 *  POST /kb/observe        — Attendant retrieval (returns working-memory brief)
 *  POST /kb/handshake      — Attendant session start
 *  POST /kb/attend         — Attendant per-turn memory gate
 *  POST /kb/reconvene      — Attendant post-compaction re-handshake
 *  POST /kb/checkpoint     — write a structured checkpoint fact
 *  POST /kb/remember       — explicit assistant memory extraction
 *  GET  /kb/entity-resolution   — resolve a raw name to canonical entity
 *  POST /kb/entity-resolution   — same (POST body)
 *  POST /kb/add-alias      — add an alias to an existing canonical entity
 *  GET  /kb/list-aliases   — list all aliases for a canonical entity
 *  GET  /kb/relationships  — get entity relationships
 *  GET  /kb/related-deep   — traverse relationship graph (multi-hop)
 *  GET  /kb/archive-history — get archive history for an entry
 */

import express, { Router, Request, Response } from 'express';
import { Iranti, ProtocolViolationError } from '../../sdk';
import { addAlias, listAliases, parseEntityString, resolveEntity } from '../../library/entity-resolution';
import { validateInput } from '../middleware/validation';
import { EntityTarget, requireAnyScope, requireEntityScopeByMethod } from '../middleware/authorization';
import type { IrantiAuthContext } from '../middleware/auth';
import {
    deleteEntryById,
    exportFacts,
    findEntriesByEntityType,
    importFact,
    type ImportConflictMode,
    type ImportRow,
} from '../../library/queries';

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

function parseEntityTarget(entity: unknown): EntityTarget {
    if (typeof entity !== 'string' || entity.trim().length === 0) {
        throw new Error('entity must be a non-empty string.');
    }

    const parsed = parseEntityString(entity.trim());
    return {
        entityType: parsed.entityType,
        entityId: parsed.entityId,
    };
}

function fromParams(req: Request): EntityTarget {
    const entityType = Array.isArray(req.params.entityType) ? req.params.entityType[0] : req.params.entityType;
    const entityId = Array.isArray(req.params.entityId) ? req.params.entityId[0] : req.params.entityId;
    if (!entityType || !entityId) {
        throw new Error('entityType and entityId are required.');
    }
    return { entityType, entityId };
}

function fallbackProtocolAgent(req: Request): string | null {
    const auth = (req as Request & { irantiAuth?: IrantiAuthContext }).irantiAuth;
    const explicit = typeof req.query.agentId === 'string'
        ? req.query.agentId.trim()
        : typeof req.query.agent === 'string'
            ? req.query.agent.trim()
            : '';
    if (explicit) return explicit;
    // Do not fall back to the API key ID as a protocol principal. Protocol
    // enforcement is only meaningful for named agents that have completed a
    // handshake + attend cycle. Using the key ID as a fallback causes any
    // programmatic or diagnostic caller (e.g. the Control Plane health probe)
    // to be blocked with 428 on the first request after an instance restart,
    // since no prior handshake/attend exists for that principal. Callers
    // without an explicit agentId get null here, which causes checkProtocol to
    // return early — no enforcement, no 428.
    return null;
}

function applyProtocolContext(iranti: Iranti, req: Request): void {
    const agentId = fallbackProtocolAgent(req);
    iranti.setSessionLedgerContext({
        source: 'api',
        host: 'api',
        agentId: agentId ?? undefined,
    });
}

function handleProtocolViolation(res: Response, error: unknown): boolean {
    if (!(error instanceof ProtocolViolationError)) {
        return false;
    }
    res.status(428).json({
        error: error.message,
        code: error.protocolViolation.code,
        protocolViolation: error.protocolViolation,
    });
    return true;
}

export function knowledgeRoutes(iranti: Iranti): Router {
    const router = Router();

    // POST /write
    router.post('/write', validateInput('write'), requireEntityScopeByMethod('kb:read', 'kb:write', (req) => parseEntityTarget(req.body.entity)), async (req: Request, res: Response) => {
        try {
            const result = await iranti.write(req.body);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /ingest
    router.post('/ingest', requireEntityScopeByMethod('kb:read', 'kb:write', (req) => parseEntityTarget(req.body.entity)), async (req: Request, res: Response) => {
        try {
            const result = await iranti.ingest(req.body);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /resolve
    router.post('/resolve', requireEntityScopeByMethod('kb:read', 'kb:write', (req) => {
        const parsed = parseResolveTarget(req.body?.entity);
        return { entityType: parsed.entityType, entityId: parsed.entityId };
    }), async (req: Request, res: Response) => {
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
    router.post('/alias', requireEntityScopeByMethod('kb:read', 'kb:write', (req) => parseEntityTarget(req.body?.canonicalEntity)), async (req: Request, res: Response) => {
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
    router.get('/entity/:entityType/:entityId/aliases', requireEntityScopeByMethod('kb:read', 'kb:write', fromParams), async (req: Request, res: Response) => {
        try {
            const { entityType, entityId } = req.params;
            const result = await listAliases(`${entityType}/${entityId}`);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /query/:entityType/:entityId/:key
    router.get('/query/:entityType/:entityId/:key', requireEntityScopeByMethod('kb:read', 'kb:write', fromParams), async (req: Request, res: Response) => {
        try {
            applyProtocolContext(iranti, req);
            const entityType = Array.isArray(req.params.entityType) ? req.params.entityType[0] : req.params.entityType;
            const entityId = Array.isArray(req.params.entityId) ? req.params.entityId[0] : req.params.entityId;
            const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
            const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
            if (asOf && Number.isNaN(asOf.getTime())) {
                return res.status(400).json({ error: 'asOf must be a valid ISO-8601 timestamp.' });
            }
            const includeExpired = req.query.includeExpired === 'true';
            const includeContested = req.query.includeContested !== 'false';
            const result = await iranti.query(`${entityType}/${entityId}`, key, {
                asOf,
                includeExpired,
                includeContested,
            });
            res.json(result);
        } catch (err) {
            if (handleProtocolViolation(res, err)) return;
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /history/:entityType/:entityId/:key
    router.get('/history/:entityType/:entityId/:key', requireEntityScopeByMethod('kb:read', 'kb:write', fromParams), async (req: Request, res: Response) => {
        try {
            applyProtocolContext(iranti, req);
            const entityType = Array.isArray(req.params.entityType) ? req.params.entityType[0] : req.params.entityType;
            const entityId = Array.isArray(req.params.entityId) ? req.params.entityId[0] : req.params.entityId;
            const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
            const includeExpired = req.query.includeExpired === 'true';
            const includeContested = req.query.includeContested !== 'false';
            const result = await iranti.history(`${entityType}/${entityId}`, key, {
                includeExpired,
                includeContested,
            });
            res.json(result);
        } catch (err) {
            if (handleProtocolViolation(res, err)) return;
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /query/:entityType/:entityId
    router.get('/query/:entityType/:entityId', requireEntityScopeByMethod('kb:read', 'kb:write', fromParams), async (req: Request, res: Response) => {
        try {
            applyProtocolContext(iranti, req);
            const { entityType, entityId } = req.params;
            const result = await iranti.queryAll(`${entityType}/${entityId}`);
            res.json(result);
        } catch (err) {
            if (handleProtocolViolation(res, err)) return;
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /search
    router.get('/search', requireAnyScope(['kb:read']), async (req: Request, res: Response) => {
        try {
            applyProtocolContext(iranti, req);
            const query = String(req.query.query ?? '').trim();
            if (!query) {
                return res.status(400).json({ error: 'query is required.' });
            }

            const limit = req.query.limit ? Number(req.query.limit) : undefined;
            const lexicalWeight = req.query.lexicalWeight ? Number(req.query.lexicalWeight) : undefined;
            const vectorWeight = req.query.vectorWeight ? Number(req.query.vectorWeight) : undefined;
            const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
            const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
            const entityId = req.query.entityId ? String(req.query.entityId) : undefined;

            if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 50)) {
                return res.status(400).json({ error: 'limit must be between 1 and 50.' });
            }
            if (lexicalWeight !== undefined && (!Number.isFinite(lexicalWeight) || lexicalWeight < 0 || lexicalWeight > 1)) {
                return res.status(400).json({ error: 'lexicalWeight must be between 0 and 1.' });
            }
            if (vectorWeight !== undefined && (!Number.isFinite(vectorWeight) || vectorWeight < 0 || vectorWeight > 1)) {
                return res.status(400).json({ error: 'vectorWeight must be between 0 and 1.' });
            }
            if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)) {
                return res.status(400).json({ error: 'minScore must be between 0 and 1.' });
            }

            const lexical = typeof lexicalWeight === 'number' ? lexicalWeight : 0.45;
            const vector = typeof vectorWeight === 'number' ? vectorWeight : 0.55;
            if ((lexical + vector) <= 0) {
                return res.status(400).json({ error: 'lexicalWeight + vectorWeight must be greater than zero.' });
            }

            const result = await iranti.search({
                query,
                limit,
                entityType,
                entityId,
                lexicalWeight: lexical,
                vectorWeight: vector,
                minScore,
            });

            res.json({ results: result });
        } catch (err) {
            if (handleProtocolViolation(res, err)) return;
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /relate
    router.post('/relate', validateInput('relate'), requireEntityScopeByMethod('kb:read', 'kb:write', (req) => [
        parseEntityTarget(req.body.fromEntity),
        parseEntityTarget(req.body.toEntity),
    ]), async (req: Request, res: Response) => {
        try {
            const { fromEntity, relationshipType, toEntity, createdBy, properties } = req.body;
            await iranti.relate(fromEntity, relationshipType, toEntity, { createdBy, properties });
            res.json({ success: true });
        } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /related/:entityType/:entityId
    router.get('/related/:entityType/:entityId', requireEntityScopeByMethod('kb:read', 'kb:write', fromParams), async (req: Request, res: Response) => {
        try {
            applyProtocolContext(iranti, req);
            const { entityType, entityId } = req.params;
            const result = await iranti.getRelated(`${entityType}/${entityId}`);
            res.json(result);
        } catch (err) {
            if (handleProtocolViolation(res, err)) return;
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /related/:entityType/:entityId/deep
    router.get('/related/:entityType/:entityId/deep', requireEntityScopeByMethod('kb:read', 'kb:write', fromParams), async (req: Request, res: Response) => {
        try {
            applyProtocolContext(iranti, req);
            const { entityType, entityId } = req.params;
            const rawDepth = parseInt(req.query.depth as string ?? '2', 10);
            const depth = Number.isFinite(rawDepth) ? Math.min(Math.max(1, rawDepth), 5) : 2;
            const result = await iranti.getRelatedDeep(`${entityType}/${entityId}`, depth);
            res.json(result);
        } catch (err) {
            if (handleProtocolViolation(res, err)) return;
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /rules
    router.get('/rules', requireAnyScope(['kb:read']), async (req: Request, res: Response) => {
        try {
            const entries = await findEntriesByEntityType('rule');
            const rules = entries.map((entry) => {
                const props = entry.properties && typeof entry.properties === 'object' && !Array.isArray(entry.properties)
                    ? entry.properties as Record<string, unknown>
                    : null;
                return {
                    ruleId: entry.entityId,
                    key: entry.key,
                    rule: entry.valueSummary ?? '',
                    triggers: Array.isArray(props?.triggers) ? props!.triggers : [],
                    enforcement: props?.enforcement ?? 'soft',
                    scope: props?.scope ?? 'project',
                    updatedAt: entry.updatedAt.toISOString(),
                };
            });
            res.json({ total: rules.length, rules });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // DELETE /rules/:ruleId
    router.delete('/rules/:ruleId', requireAnyScope(['kb:write']), async (req: Request, res: Response) => {
        try {
            const ruleId = (req.params['ruleId'] as string)?.trim();
            if (!ruleId) {
                return res.status(400).json({ error: 'ruleId is required.' });
            }
            const entries = await findEntriesByEntityType('rule');
            const matching = entries.filter((e) => e.entityId === ruleId);
            if (matching.length === 0) {
                return res.status(404).json({ error: `Rule '${ruleId}' not found.` });
            }
            for (const entry of matching) {
                await deleteEntryById(entry.id);
            }
            res.json({ deleted: ruleId, entriesRemoved: matching.length });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // GET /export
    // Streams all (or a filtered subset of) knowledge entries as JSONL.
    // The first line is a metadata header; subsequent lines are one ExportRow each.
    //
    // Query params:
    //   entityType  — restrict to entries of this entityType
    //   entityId    — restrict to a single entity (requires entityType)
    //   since       — ISO-8601 timestamp; only entries updated at or after this date
    router.get('/export', requireAnyScope(['kb:read']), async (req: Request, res: Response) => {
        try {
            const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
            const entityId   = req.query.entityId   ? String(req.query.entityId)   : undefined;
            const sinceStr   = req.query.since       ? String(req.query.since)      : undefined;

            let since: Date | undefined;
            if (sinceStr) {
                since = new Date(sinceStr);
                if (Number.isNaN(since.getTime())) {
                    return res.status(400).json({ error: 'since must be a valid ISO-8601 timestamp.' });
                }
            }

            const rows = await exportFacts({ entityType, entityId, since });
            const exportedAt = new Date().toISOString();
            const dateTag    = exportedAt.split('T')[0];

            res.setHeader('Content-Type', 'application/x-ndjson');
            res.setHeader('Content-Disposition', `attachment; filename="iranti-export-${dateTag}.jsonl"`);

            res.write(JSON.stringify({ _type: 'iranti-export', version: '1', exportedAt, total: rows.length }) + '\n');
            for (const row of rows) {
                res.write(JSON.stringify(row) + '\n');
            }
            res.end();
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // POST /import
    // Accepts a JSONL body and writes facts into the knowledge base.
    // Body must be Content-Type: text/plain or application/x-ndjson.
    // Header lines (objects with _type field) are silently skipped.
    //
    // Query params:
    //   conflict      — 'skip' (default) | 'overwrite' | 'merge'
    //   dryRun        — 'true' to parse and count without writing
    //   provenanceTag — stamped on every written entry as properties.importedFrom
    //   remap         — repeatable: 'oldEntityType=newEntityType' or
    //                   'oldType/oldId=newType/newId'
    router.post(
        '/import',
        requireAnyScope(['kb:write']),
        express.text({ type: ['text/plain', 'application/x-ndjson', 'application/octet-stream'], limit: '10mb' }),
        async (req: Request, res: Response) => {
            try {
                const conflictRaw = String(req.query.conflict ?? 'skip');
                const conflictMode: ImportConflictMode =
                    conflictRaw === 'overwrite' ? 'overwrite'
                    : conflictRaw === 'merge'   ? 'merge'
                    : 'skip';

                const dryRun        = req.query.dryRun === 'true';
                const provenanceTag = req.query.provenanceTag ? String(req.query.provenanceTag) : undefined;

                // Parse namespace remaps: ?remap=rule=policy or ?remap=project/foo=project/bar
                const remapParam = req.query.remap;
                const remapRaw: string[] = Array.isArray(remapParam)
                    ? (remapParam as string[])
                    : remapParam ? [String(remapParam)] : [];
                const remaps: Array<{ from: string; fromType: string; fromId?: string; toType: string; toId?: string }> =
                    remapRaw.flatMap((r) => {
                        const eqIdx = r.indexOf('=');
                        if (eqIdx < 1) return [];
                        const fromStr = r.slice(0, eqIdx).trim();
                        const toStr   = r.slice(eqIdx + 1).trim();
                        if (!fromStr || !toStr) return [];
                        const [fromType, fromId] = fromStr.includes('/') ? fromStr.split('/') : [fromStr, undefined];
                        const [toType,   toId]   = toStr.includes('/')   ? toStr.split('/')   : [toStr,   undefined];
                        return [{ from: fromStr, fromType, fromId, toType, toId }];
                    });

                const body = req.body as unknown;
                if (typeof body !== 'string') {
                    return res.status(400).json({
                        error: 'Request body must be JSONL text. Set Content-Type: text/plain or application/x-ndjson.',
                    });
                }

                const lines = body.split('\n');
                let added = 0, skipped = 0, overwritten = 0, parseErrors = 0, dataLines = 0;

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(trimmed);
                    } catch {
                        parseErrors++;
                        continue;
                    }

                    // Skip metadata header lines
                    if (
                        typeof parsed === 'object' &&
                        parsed !== null &&
                        '_type' in (parsed as Record<string, unknown>)
                    ) continue;

                    dataLines++;
                    let row = parsed as ImportRow;

                    // Apply namespace remaps
                    for (const remap of remaps) {
                        const typeMatches = row.entityType === remap.fromType;
                        const idMatches   = remap.fromId == null || row.entityId === remap.fromId;
                        if (typeMatches && idMatches) {
                            row = {
                                ...row,
                                entityType: remap.toType,
                                entityId:   remap.toId ?? row.entityId,
                            };
                        }
                    }

                    if (!dryRun) {
                        const result = await importFact(row, conflictMode, provenanceTag);
                        if (result.outcome === 'added')       added++;
                        else if (result.outcome === 'overwritten') overwritten++;
                        else skipped++;
                    } else {
                        skipped++; // dry-run: all count as skipped
                    }
                }

                res.json({ added, skipped, overwritten, parseErrors, total: dataLines, dryRun });
            } catch (err) {
                res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
            }
        },
    );

    return router;
}
