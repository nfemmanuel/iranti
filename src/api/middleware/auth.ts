import { Request, Response, NextFunction } from 'express';

export function authenticate(req: Request, res: Response, next: NextFunction): void {
    const apiKey = process.env.IRANTI_API_KEY;

    if (!apiKey) {
        res.status(500).json({ error: 'IRANTI_API_KEY is not configured on the server.' });
        return;
    }

    const provided = req.headers['x-iranti-key'];

    if (!provided || provided !== apiKey) {
        res.status(401).json({ error: 'Unauthorized. Provide a valid X-Iranti-Key header.' });
        return;
    }

    next();
}
