import { config } from 'dotenv';
config();

import express from 'express';
import fs from 'fs';
import path from 'path';
import { Iranti } from '../sdk';
import { knowledgeRoutes } from './routes/knowledge';
import { memoryRoutes } from './routes/memory';
import { agentRoutes } from './routes/agents';
import { devRouter } from './routes/dev';
import { batchRouter } from './routes/batch';
import { authenticate } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { snapshot, reset } from '../lib/metrics';
import { requestContext } from '../lib/requestContext';
import { validateApiKey } from '../security/apiKeys';
import { startArchivistScheduler } from './archivistScheduler';
import { getEscalationPaths } from '../lib/escalationPaths';

const app = express();

// Route prefixes
const ROUTES = {
    agents: '/agents',
    kb: '/kb',
    memory: '/memory',
    health: '/health',
};

const REQUEST_LOG_FILE =
    process.env.IRANTI_REQUEST_LOG_FILE?.trim() ||
    path.join(process.cwd(), 'logs', 'api-requests.log');

try {
    fs.mkdirSync(path.dirname(REQUEST_LOG_FILE), { recursive: true });
} catch (err) {
    console.error('[api] failed to create log directory:', err);
}

const requestLogStream = fs.createWriteStream(REQUEST_LOG_FILE, {
    flags: 'a',
    encoding: 'utf8',
});
requestLogStream.on('error', (err) => {
    console.error('[api] request log stream error:', err);
});

function logApiRequest(line: string): void {
    console.log(line);
    requestLogStream.write(`${line}\n`);
}

app.use((req, res, next) => {
    const startedAt = Date.now();
    const method = req.method;
    const url = req.originalUrl;
    const requestId = req.headers['x-request-id'];

    res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        const rid = Array.isArray(requestId) ? requestId[0] : requestId;
        const line =
            `${new Date().toISOString()} ${method} ${url} ` +
            `status=${res.statusCode} duration_ms=${durationMs}` +
            `${rid ? ` request_id=${rid}` : ''}`;
        logApiRequest(line);
    });

    requestContext.run({ llmCount: 0 }, () => next());
});

app.use(express.json({ limit: process.env.IRANTI_MAX_BODY_BYTES ?? '256kb' }));

// Public health check
app.get(ROUTES.health, (_req, res) => {
    res.json({
        status: 'ok',
        version: '0.1.0',
        provider: process.env.LLM_PROVIDER ?? 'mock',
    });
});

// Initialize Iranti SDK
const iranti = new Iranti({
    connectionString: process.env.DATABASE_URL!,
    llmProvider: (process.env.LLM_PROVIDER as 'gemini' | 'openai' | 'mock') ?? 'mock',
});

let stopArchivistScheduler: (() => void) | null = null;
void startArchivistScheduler(iranti)
    .then((scheduler) => {
        if (!scheduler.started) return;
        stopArchivistScheduler = scheduler.stop;
        console.log('[archivist] scheduler enabled');
    })
    .catch((err) => {
        console.error('[archivist] scheduler startup failed:', err);
    });

// Mount protected routes
app.use(ROUTES.agents, rateLimitMiddleware, authenticate, agentRoutes(iranti));
app.use(ROUTES.kb, rateLimitMiddleware, authenticate, knowledgeRoutes(iranti));
app.use(ROUTES.memory, rateLimitMiddleware, authenticate, memoryRoutes(iranti));
app.use('/kb', rateLimitMiddleware, batchRouter);
app.use('/dev', devRouter);

// Observability
app.get('/metrics', authenticate, (_req, res) => {
    res.json(snapshot());
});

app.post('/metrics/reset', authenticate, (_req, res) => {
    reset();
    res.json({ ok: true });
});

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
    const providedKey = req.headers['authorization']?.replace('Bearer ', '');
    const auth = await validateApiKey(providedKey);
    if (!auth.ok) {
        res.status(auth.status ?? 401).json({ error: auth.error ?? 'Unauthorized' });
        return;
    }

    try {
        const messages = (req.body.messages ?? []).map((m: any) => ({
            role: m.role as 'user' | 'assistant',
            content: String(m.content),
        }));

        // Dynamic provider selection
        const provider = process.env.LLM_PROVIDER || 'mock';
        let response;
        
        if (provider === 'gemini') {
            const { default: geminiProvider } = await import('../lib/providers/gemini');
            response = await geminiProvider.complete(messages);
        } else if (provider === 'openai') {
            const { default: openaiProvider } = await import('../lib/providers/openai');
            response = await openaiProvider.complete(messages);
        } else {
            const { default: mockProvider } = await import('../lib/providers/mock');
            response = await mockProvider.complete(messages);
        }

        res.json({
            id: `mock-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: response.text },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

const PORT = parseInt(process.env.IRANTI_PORT ?? '3001');
app.listen(PORT, () => {
    console.log(`\nIranti API running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Provider: ${process.env.LLM_PROVIDER ?? 'mock'}\n`);
    console.log(`Escalation root: ${getEscalationPaths().root}`);
    console.log(`Request log file: ${REQUEST_LOG_FILE}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (stopArchivistScheduler) stopArchivistScheduler();
        requestLogStream.end(() => process.exit(0));
    });
}
