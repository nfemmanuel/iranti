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
import { requireAnyScope, requireScopeByMethod, requireScopeFamilyByMethod } from './middleware/authorization';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { snapshot, reset } from '../lib/metrics';
import { requestContext } from '../lib/requestContext';
import { startArchivistScheduler } from './archivistScheduler';
import { getEscalationPaths } from '../lib/escalationPaths';
import { completeWithFallback } from '../lib/llm';
import { getDb } from '../library/client';
import { getVectorBackendSingleton } from '../library/queries';
import {
    InstanceRuntimeState,
    markRuntimeStopped,
    resolveRuntimeAuthorityFromEnv,
    writeRuntimeState,
} from '../lib/runtimeLifecycle';

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
const RUNTIME_AUTHORITY = resolveRuntimeAuthorityFromEnv(process.env);
const INSTANCE_DIR = RUNTIME_AUTHORITY.instanceDir;
const INSTANCE_RUNTIME_FILE = RUNTIME_AUTHORITY.runtimeFile;
const INSTANCE_NAME = process.env.IRANTI_INSTANCE_NAME?.trim() || (INSTANCE_DIR ? path.basename(INSTANCE_DIR) : 'adhoc');
const VERSION = '0.2.37';
const PORT_RAW = (process.env.IRANTI_PORT ?? '3001').trim();
const PORT = Number.parseInt(PORT_RAW, 10);

type HealthCheckState = {
    checked: boolean;
    ok: boolean;
    detail: string;
};

const runtimeMetadataHealth: HealthCheckState = {
    checked: RUNTIME_AUTHORITY.managed,
    ok: !RUNTIME_AUTHORITY.managed,
    detail: RUNTIME_AUTHORITY.managed
        ? 'waiting for initial runtime metadata write'
        : 'runtime is not running under managed instance authority',
};

const vectorBackendHealth: HealthCheckState = {
    checked: false,
    ok: true,
    detail: 'vector backend has not been probed yet',
};

function operatorStatus(): 'ok' | 'degraded' {
    if (RUNTIME_AUTHORITY.source === 'invalid') return 'degraded';
    if (runtimeMetadataHealth.checked && !runtimeMetadataHealth.ok) return 'degraded';
    if (vectorBackendHealth.checked && !vectorBackendHealth.ok) return 'degraded';
    return 'ok';
}

function assertStartupSecurity(): void {
    const pepper = process.env.IRANTI_API_KEY_PEPPER?.trim() ?? '';
    const allowInsecure = process.env.IRANTI_ALLOW_INSECURE_STARTUP === 'true';
    const productionLike = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

    if (!pepper) {
        const message = 'IRANTI_API_KEY_PEPPER is not set. API key hashes have no pepper.';
        if (productionLike && !allowInsecure) {
            throw new Error(`${message} Refusing to start in production.`);
        }
        console.warn(`[security] WARNING: ${message} Set this env var in production.`);
        return;
    }

    if (pepper.length < 32) {
        const message = `IRANTI_API_KEY_PEPPER is too short (${pepper.length}). Expected at least 32 characters.`;
        if (productionLike && !allowInsecure) {
            throw new Error(`${message} Refusing to start in production.`);
        }
        console.warn(`[security] WARNING: ${message}`);
    }
}

function assertStartupConfiguration(): void {
    const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
    if (!databaseUrl || databaseUrl.includes('yourpassword')) {
        throw new Error('DATABASE_URL is missing or still uses a placeholder value.');
    }
    if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
        throw new Error(`IRANTI_PORT must be a valid port. Received "${PORT_RAW || '(empty)'}".`);
    }
    if (RUNTIME_AUTHORITY.source === 'invalid') {
        throw new Error(`Managed runtime authority is invalid: ${RUNTIME_AUTHORITY.detail}`);
    }
}

assertStartupSecurity();
assertStartupConfiguration();

if (!RUNTIME_AUTHORITY.managed) {
    console.warn(`[runtime] ${RUNTIME_AUTHORITY.detail}`);
}

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

let runtimeState: InstanceRuntimeState | null = null;
let runtimeHeartbeat: NodeJS.Timeout | null = null;
let vectorHealthInterval: NodeJS.Timeout | null = null;
let server: ReturnType<typeof app.listen> | null = null;

function runtimeHealthPayload(): InstanceRuntimeState | null {
    return runtimeState
        ? {
            ...runtimeState,
            lastHeartbeatAt: runtimeState.lastHeartbeatAt,
            updatedAt: runtimeState.updatedAt,
        }
        : null;
}

async function persistRuntimeState(status: InstanceRuntimeState['status'], signal?: string | null): Promise<void> {
    if (!INSTANCE_RUNTIME_FILE || !INSTANCE_DIR) return;
    const now = new Date().toISOString();
    runtimeState = {
        instanceName: INSTANCE_NAME,
        instanceDir: INSTANCE_DIR,
        envFile: process.env.IRANTI_INSTANCE_ENV_FILE?.trim() || path.join(INSTANCE_DIR, '.env'),
        runtimeFile: INSTANCE_RUNTIME_FILE,
        version: VERSION,
        pid: process.pid,
        ppid: process.ppid,
        port: PORT,
        startedAt: runtimeState?.startedAt || now,
        lastHeartbeatAt: now,
        updatedAt: now,
        status,
        healthUrl: `http://localhost:${PORT}/health`,
        exitSignal: signal ?? runtimeState?.exitSignal ?? undefined,
        requestLogFile: REQUEST_LOG_FILE,
        packageRoot: process.cwd(),
        exitCode: signal ? null : runtimeState?.exitCode ?? 0,
    };
    await writeRuntimeState(INSTANCE_RUNTIME_FILE, runtimeState);
}

function markRuntimeMetadataHealth(ok: boolean, detail: string): void {
    runtimeMetadataHealth.checked = true;
    runtimeMetadataHealth.ok = ok;
    runtimeMetadataHealth.detail = detail;
}

function markVectorBackendHealth(ok: boolean, detail: string): void {
    vectorBackendHealth.checked = true;
    vectorBackendHealth.ok = ok;
    vectorBackendHealth.detail = detail;
}

async function probeVectorBackendHealth(context: 'startup' | 'interval'): Promise<void> {
    try {
        const ok = await getVectorBackendSingleton().ping();
        if (!ok) {
            markVectorBackendHealth(false, 'vector backend did not respond to ping');
            console.error(`[vector] ${context} health check failed: vector backend is not responding.`);
            return;
        }
        markVectorBackendHealth(true, 'vector backend responded to ping');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        markVectorBackendHealth(false, message);
        console.error(`[vector] ${context} health check error: ${message}`);
    }
}

function logApiRequest(line: string): void {
    console.log(line);
    requestLogStream.write(`${line}\n`);
}

app.use((req, res, next) => {
    const startedAt = Date.now();
    const method = req.method;
    const logPath = req.path; // M-7: log path only, not full URL (avoids logging sensitive query params)
    const requestId = req.headers['x-request-id'];

    res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        const rid = Array.isArray(requestId) ? requestId[0] : requestId;
        const line =
            `${new Date().toISOString()} ${method} ${logPath} ` +
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
        operatorStatus: operatorStatus(),
        version: VERSION,
        provider: process.env.LLM_PROVIDER ?? 'mock',
        runtime: runtimeHealthPayload(),
        authority: {
            managed: RUNTIME_AUTHORITY.managed,
            source: RUNTIME_AUTHORITY.source,
            detail: RUNTIME_AUTHORITY.detail,
            instanceDir: INSTANCE_DIR,
            runtimeFile: INSTANCE_RUNTIME_FILE,
        },
        checks: {
            runtimeMetadata: runtimeMetadataHealth,
            vectorBackend: vectorBackendHealth,
        },
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

function terminateStartup(code: number): void {
    if (runtimeHeartbeat) {
        clearInterval(runtimeHeartbeat);
        runtimeHeartbeat = null;
    }
    if (vectorHealthInterval) {
        clearInterval(vectorHealthInterval);
        vectorHealthInterval = null;
    }
    if (stopArchivistScheduler) {
        stopArchivistScheduler();
        stopArchivistScheduler = null;
    }
    const closeAndExit = () => requestLogStream.end(() => process.exit(code));
    if (!server) {
        closeAndExit();
        return;
    }
    server.close(() => closeAndExit());
}

// Mount protected routes
app.use(ROUTES.agents, authenticate, rateLimitMiddleware, requireScopeByMethod('agents:read', 'agents:write'), agentRoutes(iranti));
app.use('/kb/batchQuery', authenticate, rateLimitMiddleware, requireAnyScope(['kb:read']), batchRouter);
app.use(ROUTES.kb, authenticate, rateLimitMiddleware, requireScopeFamilyByMethod('kb:read', 'kb:write'), knowledgeRoutes(iranti));
app.use(ROUTES.memory, authenticate, rateLimitMiddleware, requireScopeByMethod('memory:read', 'memory:write'), memoryRoutes(iranti));
app.use('/dev', authenticate, rateLimitMiddleware, requireAnyScope(['system:admin']), devRouter);

// Observability
app.get('/metrics', authenticate, rateLimitMiddleware, requireAnyScope(['metrics:read']), (_req, res) => {
    res.json(snapshot());
});

app.post('/metrics/reset', authenticate, rateLimitMiddleware, requireAnyScope(['metrics:write']), (_req, res) => {
    reset();
    res.json({ ok: true });
});

app.post(['/v1/chat/completions', '/chat/completions'], authenticate, rateLimitMiddleware, requireAnyScope(['proxy:chat']), async (req, res) => {
    try {
        if (!Array.isArray(req.body?.messages)) {
            return res.status(400).json({ error: 'messages must be an array.' });
        }

        const messages = (req.body.messages ?? []).map((m: any) => ({
            role: m.role as 'user' | 'assistant',
            content: String(m.content),
        }));

        const preferredProvider = process.env.LLM_PROVIDER || 'mock';
        const model = typeof req.body?.model === 'string' && req.body.model.trim().length > 0
            ? req.body.model.trim()
            : undefined;
        const maxTokensRaw = req.body?.max_tokens ?? req.body?.maxTokens;
        const maxTokens = Number.isFinite(Number(maxTokensRaw)) ? Number(maxTokensRaw) : undefined;

        const response = await completeWithFallback(messages, {
            preferredProvider,
            model,
            maxTokens,
        });

        res.json({
            id: `${response.providerUsed}-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: response.model,
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

server = app.listen(PORT, () => {
    console.log(`\nIranti API running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Provider: ${process.env.LLM_PROVIDER ?? 'mock'}\n`);
    console.log(`Escalation root: ${getEscalationPaths().root}`);
    console.log(`Request log file: ${REQUEST_LOG_FILE}\n`);
    if (RUNTIME_AUTHORITY.managed && INSTANCE_RUNTIME_FILE) {
        void persistRuntimeState('running').then(() => {
            markRuntimeMetadataHealth(true, 'runtime metadata written successfully');
            if (runtimeHeartbeat) clearInterval(runtimeHeartbeat);
            runtimeHeartbeat = setInterval(() => {
                void persistRuntimeState('running').catch((err) => {
                    markRuntimeMetadataHealth(false, err instanceof Error ? err.message : String(err));
                    console.error('[runtime] failed to refresh runtime state:', err);
                });
            }, 15000);
            runtimeHeartbeat.unref();
        }).catch((err) => {
            markRuntimeMetadataHealth(false, err instanceof Error ? err.message : String(err));
            console.error('[runtime] failed to write runtime state:', err);
            terminateStartup(1);
        });
    }

    void probeVectorBackendHealth('startup');
    vectorHealthInterval = setInterval(() => {
        void probeVectorBackendHealth('interval');
    }, 60_000);
    vectorHealthInterval.unref();
});

server.on('error', (err) => {
    console.error('[runtime] API server failed to start:', err);
    terminateStartup(1);
});

async function shutdownRuntime(signal: string): Promise<void> {
    if (runtimeHeartbeat) {
        clearInterval(runtimeHeartbeat);
        runtimeHeartbeat = null;
    }
    if (vectorHealthInterval) {
        clearInterval(vectorHealthInterval);
        vectorHealthInterval = null;
    }
    if (RUNTIME_AUTHORITY.managed && INSTANCE_RUNTIME_FILE) {
        try {
            await persistRuntimeState('stopping', signal);
            await markRuntimeStopped(INSTANCE_RUNTIME_FILE, signal);
        } catch (err) {
            console.error('[runtime] failed to mark runtime stopped:', err);
        }
    }
    // M-8: Graceful DB disconnect on shutdown
    try {
        await getDb().$disconnect();
    } catch (err) {
        console.error('[db] failed to disconnect:', err);
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        void (async () => {
            if (stopArchivistScheduler) stopArchivistScheduler();
            await shutdownRuntime(signal);
            server?.close(() => {
                requestLogStream.end(() => process.exit(0));
            });
        })().catch((err) => {
            console.error('[runtime] shutdown handler failed:', err);
            requestLogStream.end(() => process.exit(1));
        });
    });
}

