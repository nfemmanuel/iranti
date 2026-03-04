import { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../../security/apiKeys';

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const provided = req.headers['x-iranti-key'];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;

    const result = await validateApiKey(providedStr);
    if (!result.ok) {
        res.status(result.status ?? 401).json({ error: result.error ?? 'Unauthorized. Provide a valid X-Iranti-Key header.' });
        return;
    }

    if (result.keyId) {
        req.headers['x-iranti-key-id'] = result.keyId;
    }

    next();
}
