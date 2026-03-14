import { NextFunction, Request, Response } from 'express';
import { evaluateEntityScopeAccess, scopeMatchesFamily, scopeMatchesGlobal } from '../../security/scopes';

export interface EntityTarget {
    entityType: string;
    entityId: string;
}

type EntityExtractor = (req: Request) => EntityTarget | EntityTarget[];

function normalizeScopes(scopes: unknown): string[] {
    if (!Array.isArray(scopes)) return ['*'];
    const normalized = scopes
        .map((scope) => String(scope).trim())
        .filter(Boolean);
    return normalized.length > 0 ? normalized : ['*'];
}

function hasGlobalScope(grantedScopes: string[], requiredScope: string): boolean {
    return grantedScopes.some((scope) => scopeMatchesGlobal(scope, requiredScope));
}

function hasScopeInFamily(grantedScopes: string[], requiredScope: string): boolean {
    return grantedScopes.some((scope) => scopeMatchesFamily(scope, requiredScope));
}

function inferRequiredScope(method: string, readScope: string, writeScope: string): string {
    const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    return isRead ? readScope : writeScope;
}

function forbid(res: Response, reason: string): void {
    res.status(403).json({
        error: 'Forbidden',
        reason,
    });
}

export function requireAnyScope(requiredScopes: string[]) {
    const required = requiredScopes.map((scope) => scope.trim()).filter(Boolean);

    return (req: Request, res: Response, next: NextFunction): void => {
        const auth = (req as any).irantiAuth;
        if (!auth) {
            res.status(401).json({ error: 'Unauthorized. Authentication is required.' });
            return;
        }

        const granted = normalizeScopes(auth.scopes);
        const allowed = required.length === 0 || required.some((scope) => hasGlobalScope(granted, scope));
        if (!allowed) {
            res.status(403).json({
                error: `Forbidden. Missing required scope. Need one of: ${required.join(', ')}`,
            });
            return;
        }

        next();
    };
}

export function requireAnyScopeFamily(requiredScopes: string[]) {
    const required = requiredScopes.map((scope) => scope.trim()).filter(Boolean);

    return (req: Request, res: Response, next: NextFunction): void => {
        const auth = (req as any).irantiAuth;
        if (!auth) {
            res.status(401).json({ error: 'Unauthorized. Authentication is required.' });
            return;
        }

        const granted = normalizeScopes(auth.scopes);
        const allowed = required.length === 0 || required.some((scope) => hasScopeInFamily(granted, scope));
        if (!allowed) {
            res.status(403).json({
                error: `Forbidden. Missing required scope. Need one of: ${required.join(', ')}`,
            });
            return;
        }

        next();
    };
}

export function requireScopeByMethod(readScope: string, writeScope: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const middleware = requireAnyScope([inferRequiredScope(req.method, readScope, writeScope)]);
        middleware(req, res, next);
    };
}

export function requireScopeFamilyByMethod(readScope: string, writeScope: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const middleware = requireAnyScopeFamily([inferRequiredScope(req.method, readScope, writeScope)]);
        middleware(req, res, next);
    };
}

export function requireEntityScopeByMethod(readScope: string, writeScope: string, extractEntities: EntityExtractor) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const auth = (req as any).irantiAuth;
        if (!auth) {
            res.status(401).json({ error: 'Unauthorized. Authentication is required.' });
            return;
        }

        let targets: EntityTarget[];
        try {
            const extracted = extractEntities(req);
            targets = Array.isArray(extracted) ? extracted : [extracted];
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
            return;
        }

        const required = inferRequiredScope(req.method, readScope, writeScope);
        const granted = normalizeScopes(auth.scopes);

        for (const target of targets) {
            const decision = evaluateEntityScopeAccess(granted, required, target.entityType, target.entityId);
            if (!decision.allowed) {
                forbid(res, decision.reason);
                return;
            }
        }

        next();
    };
}
