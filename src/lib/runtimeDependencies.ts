import net from 'net';
import { spawnSync } from 'child_process';

export type DockerContainerInstanceDependency = {
    kind: 'docker-container';
    name: string;
    healthTcpPort?: number;
    startTimeoutMs?: number;
};

export type InstanceDependency = DockerContainerInstanceDependency;

export type ParsedInstanceDependencies = {
    dependencies: InstanceDependency[];
    errors: string[];
};

export type EnsuredInstanceDependencies = {
    checked: number;
    started: string[];
    alreadyRunning: string[];
    waitedTcpPorts: number[];
};

type DockerAvailability = {
    installed: boolean;
    daemonReachable: boolean;
    detail: string;
};

function runCommandCapture(
    executable: string,
    args: string[],
    cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
    const lowerExecutable = executable.toLowerCase();
    const proc = spawnSync(executable, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32' && (lowerExecutable.endsWith('.cmd') || lowerExecutable.endsWith('.bat')),
    });

    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

function dockerExecutable(): string {
    const explicit = process.env.IRANTI_DOCKER_BIN?.trim();
    return explicit || 'docker';
}

function hasDockerInstalled(): boolean {
    try {
        const proc = runCommandCapture(dockerExecutable(), ['--version']);
        return proc.status === 0;
    } catch {
        return false;
    }
}

function inspectDockerAvailability(): DockerAvailability {
    if (!hasDockerInstalled()) {
        return {
            installed: false,
            daemonReachable: false,
            detail: 'Docker is not installed or not on PATH.',
        };
    }

    const proc = runCommandCapture(dockerExecutable(), ['info', '--format', '{{.ServerVersion}}']);
    if (proc.status === 0) {
        const version = proc.stdout.trim();
        return {
            installed: true,
            daemonReachable: true,
            detail: version
                ? `Docker daemon is reachable (server ${version}).`
                : 'Docker daemon is reachable.',
        };
    }

    const reason = (proc.stderr || proc.stdout).trim() || 'Docker daemon did not respond.';
    return {
        installed: true,
        daemonReachable: false,
        detail: `Docker CLI is installed, but the daemon is not reachable. ${reason}`,
    };
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host, port });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                resolve(false);
            });
        });

        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for TCP dependency on ${host}:${port}.`);
}

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

function asPositiveInteger(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
    return value;
}

export function parseInstanceDependencies(raw: unknown): ParsedInstanceDependencies {
    if (raw === undefined || raw === null) {
        return { dependencies: [], errors: [] };
    }
    if (!Array.isArray(raw)) {
        return { dependencies: [], errors: ['dependencies must be an array'] };
    }

    const dependencies: InstanceDependency[] = [];
    const errors: string[] = [];

    raw.forEach((item, index) => {
        const record = asObject(item);
        if (!record) {
            errors.push(`dependencies[${index}] must be an object`);
            return;
        }

        const kind = asNonEmptyString(record.kind);
        if (kind !== 'docker-container') {
            errors.push(`dependencies[${index}].kind must be 'docker-container'`);
            return;
        }

        const name = asNonEmptyString(record.name);
        if (!name) {
            errors.push(`dependencies[${index}].name is required`);
            return;
        }

        const healthTcpPort = asPositiveInteger(record.healthTcpPort);
        if (record.healthTcpPort !== undefined && healthTcpPort === undefined) {
            errors.push(`dependencies[${index}].healthTcpPort must be a positive integer`);
            return;
        }

        const startTimeoutMs = asPositiveInteger(record.startTimeoutMs);
        if (record.startTimeoutMs !== undefined && startTimeoutMs === undefined) {
            errors.push(`dependencies[${index}].startTimeoutMs must be a positive integer`);
            return;
        }

        dependencies.push({
            kind: 'docker-container',
            name,
            ...(healthTcpPort ? { healthTcpPort } : {}),
            ...(startTimeoutMs ? { startTimeoutMs } : {}),
        });
    });

    return { dependencies, errors };
}

export function describeInstanceDependency(dependency: InstanceDependency): string {
    const portSuffix = dependency.healthTcpPort ? ` -> tcp:${dependency.healthTcpPort}` : '';
    return `${dependency.kind}:${dependency.name}${portSuffix}`;
}

async function ensureDockerContainerDependency(
    dependency: DockerContainerInstanceDependency,
    cwd?: string,
): Promise<{ started: boolean; waitedTcpPort?: number }> {
    const docker = inspectDockerAvailability();
    if (!docker.installed) {
        throw new Error('Docker CLI is not installed or not on PATH.');
    }
    if (!docker.daemonReachable) {
        throw new Error(`Docker daemon is not reachable. ${docker.detail}`);
    }

    const inspectAll = runCommandCapture(dockerExecutable(), ['ps', '-a', '--format', '{{.Names}}'], cwd);
    if (inspectAll.status !== 0) {
        throw new Error((inspectAll.stderr || inspectAll.stdout).trim() || 'Failed to inspect Docker containers.');
    }

    const names = inspectAll.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (!names.includes(dependency.name)) {
        throw new Error(`Docker container dependency '${dependency.name}' was not found.`);
    }

    const runningProbe = runCommandCapture(dockerExecutable(), ['inspect', '-f', '{{.State.Running}}', dependency.name], cwd);
    if (runningProbe.status !== 0) {
        throw new Error((runningProbe.stderr || runningProbe.stdout).trim() || `Failed to inspect Docker container '${dependency.name}'.`);
    }

    let started = false;
    if (runningProbe.stdout.trim().toLowerCase() !== 'true') {
        const start = runCommandCapture(dockerExecutable(), ['start', dependency.name], cwd);
        if (start.status !== 0) {
            throw new Error((start.stderr || start.stdout).trim() || `Failed to start Docker container '${dependency.name}'.`);
        }
        started = true;
    }

    if (dependency.healthTcpPort) {
        await waitForTcpPort('127.0.0.1', dependency.healthTcpPort, dependency.startTimeoutMs ?? 30_000);
    }

    return {
        started,
        ...(dependency.healthTcpPort ? { waitedTcpPort: dependency.healthTcpPort } : {}),
    };
}

export async function ensureInstanceDependenciesHealthy(
    dependencies: InstanceDependency[],
    options: { cwd?: string } = {},
): Promise<EnsuredInstanceDependencies> {
    const summary: EnsuredInstanceDependencies = {
        checked: 0,
        started: [],
        alreadyRunning: [],
        waitedTcpPorts: [],
    };

    for (const dependency of dependencies) {
        summary.checked += 1;
        if (dependency.kind === 'docker-container') {
            const result = await ensureDockerContainerDependency(dependency, options.cwd);
            if (result.started) {
                summary.started.push(dependency.name);
            } else {
                summary.alreadyRunning.push(dependency.name);
            }
            if (result.waitedTcpPort) {
                summary.waitedTcpPorts.push(result.waitedTcpPort);
            }
        }
    }

    return summary;
}
