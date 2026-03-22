import fs from 'fs';
import fsp from 'fs/promises';
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
