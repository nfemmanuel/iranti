import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

type RuntimeEnvOptions = {
    cwd?: string;
    payloadCwd?: string;
    projectEnvFile?: string;
    instanceEnvFile?: string;
    explicitEnvFile?: string;
};

type RuntimeEnvLoadResult = {
    loadedFiles: string[];
    fallbackEnvFile?: string;
    projectEnvFile?: string;
    instanceEnvFile?: string;
    authorityMode: 'environment-only' | 'instance-authoritative' | 'project-only';
};

const PROJECT_BINDING_KEYS = new Set([
    'IRANTI_URL',
    'IRANTI_API_KEY',
    'IRANTI_AGENT_ID',
    'IRANTI_MEMORY_ENTITY',
    'IRANTI_AUTO_REMEMBER',
    'IRANTI_PROJECT_MODE',
    'IRANTI_INSTANCE',
    'IRANTI_INSTANCE_ENV',
]);

function parseEnvFile(filePath: string): Record<string, string> {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return dotenv.parse(raw);
}

function applyEnvVars(
    vars: Record<string, string>,
    initialEnvKeys: Set<string>,
    options: { overrideExisting?: boolean } = {},
): void {
    const { overrideExisting = false } = options;
    for (const [key, value] of Object.entries(vars)) {
        if (!overrideExisting && initialEnvKeys.has(key)) continue;
        process.env[key] = value;
    }
}

function dedupePaths(paths: Array<string | undefined | null>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const candidate of paths) {
        if (!candidate) continue;
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
    }
    return out;
}

function walkAncestorCandidates(startDir: string | undefined, relativePath: string): string[] {
    if (!startDir) return [];
    const results: string[] = [];
    let current = path.resolve(startDir);

    while (true) {
        results.push(path.join(current, relativePath));
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return results;
}

function findProjectEnvFile(options: RuntimeEnvOptions): string | undefined {
    const explicit = options.projectEnvFile?.trim() || process.env.IRANTI_PROJECT_ENV?.trim();
    if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

    const candidates = dedupePaths([
        ...walkAncestorCandidates(options.payloadCwd, '.env.iranti'),
        ...walkAncestorCandidates(options.cwd, '.env.iranti'),
        ...walkAncestorCandidates(process.cwd(), '.env.iranti'),
    ]);

    return candidates.find((candidate) => fs.existsSync(candidate));
}

function findFallbackEnvFile(options: RuntimeEnvOptions): string | undefined {
    const explicit = options.explicitEnvFile?.trim() || process.env.IRANTI_ENV_FILE?.trim();
    if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

    const candidates = dedupePaths([
        ...walkAncestorCandidates(options.payloadCwd, '.env'),
        ...walkAncestorCandidates(options.cwd, '.env'),
        ...walkAncestorCandidates(process.cwd(), '.env'),
        path.resolve(__dirname, '..', '..', '.env'),
        path.resolve(__dirname, '..', '..', '..', '.env'),
    ]);

    return candidates.find((candidate) => fs.existsSync(candidate));
}

export function loadRuntimeEnv(options: RuntimeEnvOptions = {}): RuntimeEnvLoadResult {
    const loadedFiles: string[] = [];
    const initialEnvKeys = new Set(Object.keys(process.env));

    const fallbackEnvFile = findFallbackEnvFile(options);
    if (fallbackEnvFile) {
        const explicitFallback = Boolean(options.explicitEnvFile?.trim() || process.env.IRANTI_ENV_FILE?.trim());
        applyEnvVars(parseEnvFile(fallbackEnvFile), initialEnvKeys, { overrideExisting: explicitFallback });
        loadedFiles.push(fallbackEnvFile);
    }

    const projectEnvFile = findProjectEnvFile(options);
    const projectEnv = projectEnvFile && fs.existsSync(projectEnvFile)
        ? parseEnvFile(projectEnvFile)
        : null;

    const instanceEnvFile = options.instanceEnvFile?.trim()
        || process.env.IRANTI_INSTANCE_ENV?.trim()
        || projectEnv?.IRANTI_INSTANCE_ENV;

    const resolvedInstanceEnvFile = instanceEnvFile && fs.existsSync(instanceEnvFile)
        ? path.resolve(instanceEnvFile)
        : undefined;

    if (resolvedInstanceEnvFile) {
        applyEnvVars(parseEnvFile(resolvedInstanceEnvFile), initialEnvKeys, { overrideExisting: true });
        loadedFiles.push(resolvedInstanceEnvFile);
    }

    if (projectEnvFile && projectEnv) {
        const projectVars = resolvedInstanceEnvFile
            ? Object.fromEntries(Object.entries(projectEnv).filter(([key]) => PROJECT_BINDING_KEYS.has(key)))
            : projectEnv;
        applyEnvVars(projectVars, initialEnvKeys, { overrideExisting: true });
        loadedFiles.push(projectEnvFile);
    }

    return {
        loadedFiles,
        fallbackEnvFile,
        projectEnvFile,
        instanceEnvFile: resolvedInstanceEnvFile,
        authorityMode: resolvedInstanceEnvFile
            ? 'instance-authoritative'
            : projectEnvFile
                ? 'project-only'
                : 'environment-only',
    };
}
