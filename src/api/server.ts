/**
 * iranti API server — the standalone Express HTTP server.
 *
 * Initialises and starts the iranti REST API on `PORT` (default 3500).
 * Wires together:
 *  - Express app with trust-proxy configuration (`IRANTI_TRUST_PROXY`)
 *  - Rate limiting middleware (memory or Postgres-backed)
 *  - JWT/API-key authentication middleware
 *  - Scope-based authorization middleware
 *  - Route groups: `/agents`, `/kb`, `/memory`, `/batch`, `/dev`
 *  - `/health` endpoint with live DB + vector backend + schema version checks
 *  - Request logging to `IRANTI_REQUEST_LOG_FILE`
 *  - Archivist scheduler (interval + escalation file watcher)
 *  - Graceful shutdown: drains in-flight requests, stops the scheduler,
 *    disconnects the DB pool, writes a `stopped` runtime state marker
 *
 * Runtime authority (`IRANTI_INSTANCE_DIR` / `IRANTI_INSTANCE_NAME`) controls
 * which runtime.json the server reads and writes for health reporting and
 * instance discovery by `iranti run`.
 */

import { config } from 'dotenv';
config();

import express from 'express';
import fs from 'fs';
import path from 'path';
import { knowledgeRoutes } from './routes/knowledge';
import { memoryRoutes } from './routes/memory';
import { agentRoutes } from './routes/agents';
import { devRouter } from './routes/dev';
import { batchRouter } from './routes/batch';
import { authenticate } from './middleware/auth';
import { createOrRotateApiKey, listApiKeys } from '../security/apiKeys';
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
import { createFirstPartyIranti } from '../lib/createFirstPartyIranti';
import { resolvePackageRoot } from '../lib/packageRoot';
import { createHealthCheckState, createVectorBackendMonitor, deriveOperatorStatus, HealthCheckState } from './healthChecks';

const app = express();

// Trust proxy: set IRANTI_TRUST_PROXY=true when running behind nginx/caddy/etc.
// Without this, req.ip falls back to the socket address and X-Forwarded-For is ignored,
// which allows IP spoofing of the unauthenticated rate-limit fallback path.
// Accepts: 'true'|'1' (trust all proxies), a hop count integer, or a specific IP/subnet.
const trustProxyEnv = process.env.IRANTI_TRUST_PROXY?.trim();
if (trustProxyEnv && trustProxyEnv !== 'false' && trustProxyEnv !== '0') {
    const hopCount = Number.parseInt(trustProxyEnv, 10);
    app.set('trust proxy', Number.isFinite(hopCount) ? hopCount : trustProxyEnv === 'true' || trustProxyEnv === '1' ? true : trustProxyEnv);
}

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
const VERSION = '0.3.40';
const PORT_RAW = (process.env.IRANTI_PORT ?? '3001').trim();
const PORT = Number.parseInt(PORT_RAW, 10);

const runtimeMetadataHealth: HealthCheckState = createHealthCheckState({
    checked: RUNTIME_AUTHORITY.managed,
    ok: !RUNTIME_AUTHORITY.managed,
    detail: RUNTIME_AUTHORITY.managed
        ? 'waiting for initial runtime metadata write'
        : 'runtime is not running under managed instance authority',
});

function operatorStatus(): 'ok' | 'degraded' {
    return deriveOperatorStatus({
        runtimeAuthoritySource: RUNTIME_AUTHORITY.source,
        runtimeMetadataHealth,
        vectorBackendHealth: vectorBackendMonitor.state,
    });
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

function packageRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i += 1) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

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
        packageRoot: resolvePackageRoot(__dirname) ?? process.cwd(),
        exitCode: signal ? null : runtimeState?.exitCode ?? 0,
    };
    await writeRuntimeState(INSTANCE_RUNTIME_FILE, runtimeState);
}

function markRuntimeMetadataHealth(ok: boolean, detail: string): void {
    runtimeMetadataHealth.checked = true;
    runtimeMetadataHealth.ok = ok;
    runtimeMetadataHealth.detail = detail;
}

const vectorBackendMonitor = createVectorBackendMonitor({
    ping: () => getVectorBackendSingleton().ping(),
    logError: (message) => console.error(message),
});

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
            vectorBackend: vectorBackendMonitor.state,
        },
    });
});

// Initialize Iranti SDK
const iranti = createFirstPartyIranti({
    connectionString: process.env.DATABASE_URL!,
    llmProvider: (process.env.LLM_PROVIDER as 'gemini' | 'openai' | 'mock') ?? 'mock',
    sessionLedgerSource: 'api',
    sessionLedgerHost: 'api_server',
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

        const messages = (req.body.messages ?? []).map((m: Record<string, unknown>) => ({
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
            ledgerContext: {
                source: 'api',
                host: 'api_server',
                operation: 'chat_completions_proxy',
            },
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

// Bootstrap: if IRANTI_BOOTSTRAP=true and no keys exist yet, create one and log it.
// The provision script reads the token from fly logs and then unsets IRANTI_BOOTSTRAP.
async function maybeBootstrapApiKey(): Promise<void> {
    if (process.env.IRANTI_BOOTSTRAP !== 'true') return;
    try {
        const existing = await listApiKeys();
        const activeKeys = existing.filter((k) => k.isActive);
        if (activeKeys.length > 0) {
            console.log('[bootstrap] Keys already exist — skipping bootstrap.');
            return;
        }
        const { token } = await createOrRotateApiKey({
            keyId: 'bootstrap',
            owner: process.env.IRANTI_INSTANCE_NAME ?? 'cloud-tenant',
            scopes: [],
            description: 'Bootstrap key created at first startup. Rotate or revoke after setup.',
        });
        // Log the token so the provision script can extract it via fly logs.
        // Format is stable — provision.sh greps for this exact prefix.
        console.log(`[bootstrap] IRANTI_API_KEY=${token}`);
        console.log('[bootstrap] ⚠  Save this key — it will not appear again. Rotate via: iranti add api-key');
    } catch (err) {
        console.error('[bootstrap] Failed to create bootstrap key:', err instanceof Error ? err.message : String(err));
    }
}

/**
 * POST the bootstrap callback with the retry schedule from the ICC
 * tenant-bootstrap-contract: [1s, 2s, 5s, 15s, 60s] — total wall-clock
 * ceiling ~83s, which sits just under the control plane cron worker's
 * 120s waitForMachineState('started') timeout.
 *
 * Retry policy (per contract):
 *   - 2xx        → return
 *   - 4xx        → throw immediately, do NOT retry (control plane made
 *                   a permanent decision — retrying cannot succeed)
 *   - 5xx        → retry with backoff
 *   - network    → retry with backoff
 *   - retries exhausted → throw the last error
 */
async function postCloudBootstrapCallback(
    callbackUrl: string,
    body: {
        workspaceId: string;
        bootstrapToken: string;
        apiKey: string;
        apiKeyPrefix?: string;
        apiKeyLabel?: string;
    },
): Promise<{ status: number; responseBody: unknown }> {
    const backoffMs = [1_000, 2_000, 5_000, 15_000, 60_000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
        let status = 0;
        let responseBody: unknown = null;
        let networkError: Error | null = null;

        try {
            const res = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            status = res.status;
            try {
                responseBody = await res.json();
            } catch {
                try {
                    responseBody = await res.text();
                } catch {
                    responseBody = null;
                }
            }
        } catch (err) {
            networkError = err instanceof Error ? err : new Error(String(err));
        }

        // 2xx → success, return immediately
        if (status >= 200 && status < 300) {
            return { status, responseBody };
        }

        // 4xx → terminal. Per contract, retrying cannot succeed.
        if (status >= 400 && status < 500) {
            throw new Error(
                `Cloud bootstrap callback returned ${status}: ${JSON.stringify(responseBody)}. Terminal per contract — will not retry.`,
            );
        }

        // 5xx or network error → retry with backoff
        lastError = networkError ?? new Error(
            `Cloud bootstrap callback returned ${status}: ${JSON.stringify(responseBody)}`,
        );

        const delay = backoffMs[attempt];
        const attemptsLeft = backoffMs.length - attempt - 1;
        console.error(
            `[cloud-bootstrap] Attempt ${attempt + 1}/${backoffMs.length} failed: ${lastError.message}. Retrying in ${delay}ms (${attemptsLeft} attempts left).`,
        );
        await new Promise((r) => setTimeout(r, delay));
    }

    throw lastError ?? new Error('Cloud bootstrap callback failed after exhausting retries');
}

/**
 * Cloud bootstrap — the Iranti Collaborative Cloud (ICC) path.
 *
 * When this iranti-server instance runs inside an ICC-provisioned Fly
 * machine, the cloud drainer injects three env vars at machine creation
 * time: IRANTI_WORKSPACE_ID, IRANTI_BOOTSTRAP_TOKEN, IRANTI_CLOUD_CALLBACK_URL.
 * On first boot we:
 *
 *   1. Mint a workspace API key into the LOCAL registry (knowledgeEntry
 *      table in this tenant's own Postgres). Subsequent authenticated
 *      requests from the end user will validate against the sha256+pepper
 *      hash stored locally.
 *
 *   2. POST the plaintext key to the control plane's bootstrap-callback
 *      route, along with the workspaceId + bootstrapToken (one-time
 *      bearer). The control plane argon2id-hashes it for display in the
 *      user's dashboard, then marks the TenantInstance row as
 *      bootstrapped and clears the bootstrapToken.
 *
 * Contract spec: iranti-cloud/docs/tenant-bootstrap-contract.md.
 *
 * Return value:
 *   { ran: true }  — cloud mode activated (either freshly bootstrapped
 *                    OR skipped because a prior attempt already ran on
 *                    this machine — the "Fly restarted us" case).
 *   { ran: false } — cloud env vars absent. Caller should fall back to
 *                    the legacy log-grep path (maybeBootstrapApiKey).
 *
 * Throws on:
 *   - 4xx from the callback (terminal per contract)
 *   - 5xx/network errors exhausting all retries
 *   - Any DB error during local key minting
 *
 * The caller must exit the process on throw so Fly restarts the machine.
 * After enough restart attempts the ICC cron worker will mark the
 * provisioning job FAILED and the user can retry via the dashboard.
 */
async function maybeRunCloudBootstrap(): Promise<{ ran: boolean }> {
    const workspaceId = process.env.IRANTI_WORKSPACE_ID?.trim();
    const bootstrapToken = process.env.IRANTI_BOOTSTRAP_TOKEN?.trim();
    const callbackUrl = process.env.IRANTI_CLOUD_CALLBACK_URL?.trim();

    if (!workspaceId || !bootstrapToken || !callbackUrl) {
        return { ran: false };
    }

    console.log(`[cloud-bootstrap] Cloud mode detected — workspace=${workspaceId}`);

    // Idempotency guard: if a cloud_bootstrap key already exists in the
    // local registry, this machine has already been through this flow.
    // Skip entirely — the control plane's bootstrapToken has been
    // cleared server-side, so calling it again would 401 us into a
    // crash loop.
    //
    // Using the API key registry itself as the durability signal
    // (instead of a /data/bootstrap_done marker file) means this works
    // on Fly machines without a persistent volume mount. The registry
    // lives in the tenant's own Postgres, which Fly persists across
    // machine restarts via its managed volume.
    const existing = await listApiKeys();
    const prior = existing.find(
        (k) => k.keyId === 'cloud_bootstrap' && k.isActive,
    );
    if (prior) {
        console.log(
            `[cloud-bootstrap] cloud_bootstrap key already exists in registry (owner=${prior.owner}) — machine-restart scenario, skipping callback.`,
        );
        return { ran: true };
    }

    console.log(`[cloud-bootstrap] First boot — minting API key for workspace ${workspaceId}`);

    // Mint locally FIRST, then call the control plane. If we crashed
    // between the control plane acking and the local write, the user's
    // workspace would be listed as provisioned in their dashboard but
    // this server would have no key to validate their requests against.
    // Local-first ordering ensures the tenant side is always at least
    // as far along as the control plane thinks it is.
    const { token } = await createOrRotateApiKey({
        keyId: 'cloud_bootstrap',
        owner: workspaceId,
        scopes: [],
        description: `Bootstrap key minted at first boot for ICC workspace ${workspaceId}.`,
    });

    console.log(`[cloud-bootstrap] Key minted. POSTing to ${callbackUrl}`);

    const result = await postCloudBootstrapCallback(callbackUrl, {
        workspaceId,
        bootstrapToken,
        apiKey: token,
        apiKeyPrefix: token.slice(0, 8),
        apiKeyLabel: 'cloud bootstrap',
    });

    console.log(
        `[cloud-bootstrap] ✓ Callback succeeded (status=${result.status}). Workspace ${workspaceId} is live.`,
    );
    return { ran: true };
}

// Wrap startup in an async IIFE so we can await cloud bootstrap BEFORE
// accepting HTTP traffic. In ICC mode, failing bootstrap must crash the
// machine so Fly retries and the cron worker eventually marks the
// provisioning job FAILED — accepting traffic on a partially-bootstrapped
// machine would leak an orphan workspace that the control plane doesn't
// know about and has no API key for.
//
// In non-ICC mode (cloud env vars absent), maybeRunCloudBootstrap
// returns { ran: false } immediately and we fall through to the legacy
// log-grep path inside the listen callback. That path remains
// fire-and-forget so operator-run deployments (where a human greps the
// key out of fly logs via provision.sh) behave exactly as before.
void (async () => {
    let cloudBootstrapRan = false;
    try {
        const cloudResult = await maybeRunCloudBootstrap();
        cloudBootstrapRan = cloudResult.ran;
    } catch (err) {
        console.error('[cloud-bootstrap] ✗ FAILED — cannot start server.');
        console.error('[cloud-bootstrap]', err instanceof Error ? err.message : String(err));
        console.error(
            '[cloud-bootstrap] See iranti-cloud/docs/tenant-bootstrap-contract.md for recovery semantics.',
        );
        process.exit(1);
    }

    server = app.listen(PORT, () => {
        console.log(`\nIranti API running on port ${PORT}`);
        console.log(`Health: http://localhost:${PORT}/health`);
        console.log(`Provider: ${process.env.LLM_PROVIDER ?? 'mock'}\n`);
        console.log(`Escalation root: ${getEscalationPaths().root}`);
        console.log(`Request log file: ${REQUEST_LOG_FILE}\n`);
        // Legacy log-grep bootstrap — only fires when cloud mode didn't
        // activate, preserving the old IRANTI_BOOTSTRAP=true behaviour
        // for non-ICC deployments.
        if (!cloudBootstrapRan) {
            void maybeBootstrapApiKey();
        }
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

        void vectorBackendMonitor.probe('startup');
        vectorHealthInterval = vectorBackendMonitor.start();
    });

    server.on('error', (err) => {
        console.error('[runtime] API server failed to start:', err);
        terminateStartup(1);
    });
})();

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

