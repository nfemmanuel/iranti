import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import https from 'https';
import path from 'path';

export type InstanceRuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped';

export type InstanceRuntimeMetadata = {
    instanceName: string;
    instanceDir: string;
    envFile: string;
    runtimeFile: string;
    version: string;
    pid: number;
    ppid: number;
    port: number;
    startedAt: string;
    lastHeartbeatAt: string;
    updatedAt: string;
    status: InstanceRuntimeStatus;
    healthUrl?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
    requestLogFile?: string;
    packageRoot?: string;
};

export type InstanceRuntimeState = InstanceRuntimeMetadata;

export type RuntimeHealthProbe = {
    checked: boolean;
    ok: boolean;
    source: 'health-url' | 'port-health' | 'none';
    detail: string;
};

export type RuntimeOperatorClassification = 'running' | 'unhealthy' | 'stale' | 'stopped' | 'missing' | 'invalid';

export type RuntimeInspection = {
    state: InstanceRuntimeState | null;
    processAlive: boolean;
    running: boolean;
    stale: boolean;
    classification: RuntimeOperatorClassification;
    detail: string;
    health: RuntimeHealthProbe;
};

export type InstanceRuntimeSnapshot = {
    runtimeFile: string;
    metadata: InstanceRuntimeMetadata | null;
    pid: number | null;
    processAlive: boolean;
    observedAt: string;
};

export function runtimeFileForInstance(instanceDir: string): string {
    return path.join(instanceDir, 'runtime.json');
}

export function resolveInstanceDirFromRuntimeEnv(env: Record<string, string | undefined>): string | null {
    const escalationDir = env.IRANTI_ESCALATION_DIR?.trim();
    if (escalationDir) {
        return path.resolve(path.join(escalationDir, '..'));
    }

    const requestLogFile = env.IRANTI_REQUEST_LOG_FILE?.trim();
    if (requestLogFile) {
        return path.resolve(path.join(path.dirname(requestLogFile), '..'));
    }

    return null;
}

export function resolveRuntimeFileFromRuntimeEnv(env: Record<string, string | undefined>): string | null {
    const instanceDir = resolveInstanceDirFromRuntimeEnv(env);
    return instanceDir ? runtimeFileForInstance(instanceDir) : null;
}

export function isPidAlive(pid: number | null | undefined): boolean {
    if (!pid || !Number.isFinite(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function isPidRunning(pid: number | null | undefined): boolean {
    return isPidAlive(pid);
}

export async function waitForPidExit(pid: number, timeoutMs: number, pollMs: number = 250): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return !isPidAlive(pid);
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeRuntimeStatus(value: unknown): InstanceRuntimeStatus {
    return value === 'starting' || value === 'running' || value === 'stopping' || value === 'stopped'
        ? value
        : 'running';
}

export function readInstanceRuntime(runtimeFile: string): InstanceRuntimeMetadata | null {
    if (!fs.existsSync(runtimeFile)) return null;
    try {
        const raw = fs.readFileSync(runtimeFile, 'utf8');
        const parsed = JSON.parse(raw) as Partial<InstanceRuntimeMetadata>;
        const inferredInstanceDir = path.dirname(runtimeFile);
        const instanceDir = asString(parsed.instanceDir) ?? inferredInstanceDir;
        const instanceName = asString(parsed.instanceName) ?? path.basename(instanceDir);
        const envFile = asString(parsed.envFile) ?? path.join(instanceDir, '.env');
        const normalizedRuntimeFile = asString(parsed.runtimeFile) ?? runtimeFile;
        const version = asString(parsed.version);
        const pid = asNumber(parsed.pid);
        const port = asNumber(parsed.port);
        const startedAt = asString(parsed.startedAt);

        if (!version || pid === null || port === null || !startedAt) {
            return null;
        }

        const lastHeartbeatAt = asString(parsed.lastHeartbeatAt) ?? startedAt;
        const updatedAt = asString(parsed.updatedAt) ?? lastHeartbeatAt;

        return {
            instanceName,
            instanceDir,
            envFile,
            runtimeFile: normalizedRuntimeFile,
            version,
            pid,
            ppid: asNumber(parsed.ppid) ?? 0,
            port,
            startedAt,
            lastHeartbeatAt,
            updatedAt,
            status: normalizeRuntimeStatus(parsed.status),
            healthUrl: asString(parsed.healthUrl) ?? undefined,
            exitCode: parsed.exitCode ?? undefined,
            exitSignal: asString(parsed.exitSignal) ?? undefined,
            requestLogFile: asString(parsed.requestLogFile) ?? undefined,
            packageRoot: asString(parsed.packageRoot) ?? undefined,
        };
    } catch {
        return null;
    }
}

export async function readRuntimeState(runtimeFile: string): Promise<InstanceRuntimeState | null> {
    return readInstanceRuntime(runtimeFile);
}

export async function probeRuntimeHealth(urlString: string, timeoutMs: number = 800): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: { ok: boolean; detail: string }) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        let parsed: URL;
        try {
            parsed = new URL(urlString);
        } catch {
            finish({ ok: false, detail: 'invalid health URL' });
            return;
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
            res.resume();
            if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
                finish({ ok: true, detail: `health ${res.statusCode}` });
                return;
            }
            finish({ ok: false, detail: `health ${res.statusCode ?? 'unknown'}` });
        });

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (error) => {
            finish({ ok: false, detail: error.message });
        });
        req.end();
    });
}

export async function inspectRuntimeState(runtimeFile: string): Promise<RuntimeInspection> {
    if (!fs.existsSync(runtimeFile)) {
        return {
            state: null,
            processAlive: false,
            running: false,
            stale: false,
            classification: 'missing',
            detail: 'no runtime metadata',
            health: { checked: false, ok: false, source: 'none', detail: 'no runtime metadata' },
        };
    }

    const state = await readRuntimeState(runtimeFile);
    if (!state) {
        return {
            state: null,
            processAlive: false,
            running: false,
            stale: false,
            classification: 'invalid',
            detail: 'runtime metadata is unreadable or incomplete',
            health: { checked: false, ok: false, source: 'none', detail: 'runtime metadata unavailable' },
        };
    }

    const expectedInstanceDir = path.resolve(path.dirname(runtimeFile));
    const expectedRuntimeFile = path.resolve(runtimeFile);
    const expectedEnvFile = path.resolve(path.join(expectedInstanceDir, '.env'));
    const expectedInstanceName = path.basename(expectedInstanceDir);
    const ownershipIssues = [
        path.resolve(state.instanceDir) !== expectedInstanceDir ? `instanceDir points to ${state.instanceDir}` : null,
        path.resolve(state.runtimeFile) !== expectedRuntimeFile ? `runtimeFile points to ${state.runtimeFile}` : null,
        path.resolve(state.envFile) !== expectedEnvFile ? `envFile points to ${state.envFile}` : null,
        state.instanceName !== expectedInstanceName ? `instanceName is ${state.instanceName}` : null,
    ].filter((value): value is string => Boolean(value));
    if (ownershipIssues.length > 0) {
        return {
            state,
            processAlive: false,
            running: false,
            stale: false,
            classification: 'invalid',
            detail: `runtime metadata does not belong to this instance: ${ownershipIssues.join('; ')}`,
            health: { checked: false, ok: false, source: 'none', detail: 'runtime metadata ownership mismatch' },
        };
    }

    const processAlive = isPidAlive(state.pid);
    const stale = !processAlive && state.status !== 'stopped';
    const healthUrl = state.healthUrl?.trim() || `http://127.0.0.1:${state.port}/health`;
    const healthResult = processAlive
        ? await probeRuntimeHealth(healthUrl)
        : { ok: false, detail: stale ? 'process not running' : 'runtime stopped' };
    const healthSource: RuntimeHealthProbe['source'] = state.healthUrl?.trim() ? 'health-url' : processAlive ? 'port-health' : 'none';
    const running = processAlive && healthResult.ok;
    const classification: RuntimeOperatorClassification = running
        ? 'running'
        : stale
            ? 'stale'
            : processAlive
                ? 'unhealthy'
                : 'stopped';

    return {
        state,
        processAlive,
        running,
        stale,
        classification,
        detail: running
            ? `pid=${state.pid} version=${state.version}`
            : stale
                ? `last_pid=${state.pid} version=${state.version}`
                : processAlive
                    ? `pid=${state.pid} version=${state.version} health=${healthResult.detail}`
                    : `version=${state.version}`,
        health: {
            checked: processAlive,
            ok: running,
            source: healthSource,
            detail: healthResult.detail,
        },
    };
}

export async function writeInstanceRuntime(runtimeFile: string, metadata: InstanceRuntimeMetadata): Promise<void> {
    await fsp.mkdir(path.dirname(runtimeFile), { recursive: true });
    await fsp.writeFile(runtimeFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

export async function writeRuntimeState(runtimeFile: string, metadata: InstanceRuntimeState): Promise<void> {
    await writeInstanceRuntime(runtimeFile, metadata);
}

export async function updateInstanceRuntime(
    runtimeFile: string,
    updater: (current: InstanceRuntimeMetadata | null) => InstanceRuntimeMetadata | null
): Promise<InstanceRuntimeMetadata | null> {
    const current = readInstanceRuntime(runtimeFile);
    const next = updater(current);
    if (!next) return null;
    await writeInstanceRuntime(runtimeFile, next);
    return next;
}

export async function markRuntimeStopped(runtimeFile: string, signal?: string | null): Promise<InstanceRuntimeState | null> {
    return await updateInstanceRuntime(runtimeFile, (current) => {
        if (!current) return null;
        const updatedAt = new Date().toISOString();
        return {
            ...current,
            status: 'stopped',
            updatedAt,
            lastHeartbeatAt: updatedAt,
            exitSignal: signal ?? current.exitSignal ?? null,
            exitCode: current.exitCode ?? 0,
        };
    });
}
