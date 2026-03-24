import { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../../security/apiKeys';

export interface IrantiAuthContext {
    mode: string;
    keyId: string;
    owner: string;
    scopes: string[];
}

declare global {
    namespace Express {
        interface Request {
            irantiAuth?: IrantiAuthContext;
        }
    }
}

function extractApiKey(req: Request): string | undefined {
    const fromHeader = req.headers['x-iranti-key'];
    const keyHeader = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
    if (typeof keyHeader === 'string' && keyHeader.trim().length > 0) {
        return keyHeader.trim();
    }

    const authHeader = req.headers['authorization'];
    const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!auth) return undefined;

    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return undefined;
    const token = match[1].trim();
    return token.length > 0 ? token : undefined;
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const providedStr = extractApiKey(req);

    const result = await validateApiKey(providedStr);
    if (!result.ok) {
        res.status(result.status ?? 401).json({ error: result.error ?? 'Unauthorized. Provide a valid X-Iranti-Key header.' });
        return;
    }

    req.irantiAuth = {
        mode: result.mode ?? 'registry',
        keyId: result.keyId ?? 'unknown',
        owner: result.owner ?? 'unknown',
        scopes: result.scopes ?? ['*'],
    };

    next();
}
