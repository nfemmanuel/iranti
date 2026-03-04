import { NextFunction, Request, Response } from 'express';

function normalizeScopes(scopes: unknown): string[] {
    if (!Array.isArray(scopes)) return ['*'];
    const normalized = scopes
        .map((scope) => String(scope).trim().toLowerCase())
        .filter(Boolean);
    return normalized.length > 0 ? normalized : ['*'];
}

function hasScope(grantedScopes: string[], requiredScope: string): boolean {
    const required = requiredScope.toLowerCase();
    if (grantedScopes.includes('*')) return true;
    if (grantedScopes.includes(required)) return true;

    for (const granted of grantedScopes) {
        if (!granted.endsWith(':*')) continue;
        const prefix = granted.slice(0, -1); // keep trailing ":"
        if (required.startsWith(prefix)) return true;
    }
    return false;
}

export function requireAnyScope(requiredScopes: string[]) {
    const required = requiredScopes.map((scope) => scope.trim().toLowerCase()).filter(Boolean);

    return (req: Request, res: Response, next: NextFunction): void => {
        const auth = (req as any).irantiAuth;
        if (!auth) {
            res.status(401).json({ error: 'Unauthorized. Authentication is required.' });
            return;
        }

        const granted = normalizeScopes(auth.scopes);
        const allowed = required.length === 0 || required.some((scope) => hasScope(granted, scope));
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
        const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
        const middleware = requireAnyScope([isRead ? readScope : writeScope]);
        middleware(req, res, next);
    };
}

