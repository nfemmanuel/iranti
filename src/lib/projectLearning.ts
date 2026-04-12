/**
 * Project learning snapshot writer for `iranti project init`.
 *
 * When a project is bound to an Iranti instance, this module collects a
 * lightweight bounded snapshot of the project's structure and writes it to
 * the `codebase/{name}_{hash}` entity in the Iranti library. The snapshot
 * is intentionally scoped to manifest files and directory structure — it is
 * NOT a crawler, watcher, or autonomous full-repo understanding pass.
 *
 * Snapshot keys written:
 *   project_overview  — languages, frameworks, package manager, README summary
 *   project_scripts   — package.json scripts list
 *   project_layout    — manifest files present + source directory layout
 *   project_binding   — entity mapping, agent ID, project mode, instance env reference
 *
 * The codebase entity ID is derived as `codebase/{basename}_{sha1_prefix}` so
 * the same project path always maps to the same entity, even after renames.
 *
 * Key exports:
 *   - writeProjectLearningSnapshot()    — collect + write snapshot; returns status
 *   - deriveProjectCodebaseEntity()     — compute the stable codebase entity ID for a path
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { disconnectDb } from '../library/client';
import { createFirstPartyIranti } from './createFirstPartyIranti';
import { buildSemanticFactTags } from './semanticFactTags';

type ProjectBindingEnv = Record<string, string>;

type ProjectSnapshot = {
    projectName: string;
    projectPath: string;
    codebaseEntity: string;
    boundary: string;
    learnedAt: string;
    packageManager: string | null;
    languages: string[];
    frameworks: string[];
    dependencyHighlights: string[];
    manifests: {
        packageJson: boolean;
        tsconfig: boolean;
        jsconfig: boolean;
        pyprojectToml: boolean;
        requirementsTxt: boolean;
        readme: boolean;
        prismaSchema: boolean;
        dockerCompose: boolean;
    };
    sourceDirectories: string[];
    packageScripts: string[];
    readmeSummary: string | null;
    sourceFiles: string[];
};

export type ProjectLearningStatus =
    | { status: 'written'; detail: string; entity: string; keys: string[]; }
    | { status: 'skipped' | 'failed'; detail: string; entity: string | null; keys: string[]; };

const SOURCE_DIRECTORIES = ['src', 'app', 'pages', 'components', 'lib', 'api', 'server', 'client', 'prisma', 'tests'];
const KNOWN_FRAMEWORKS = ['next', 'react', 'vite', 'astro', 'express', 'fastify', 'vue', 'nuxt', 'svelte', 'nestjs', 'remix'];
const HIGHLIGHT_PACKAGES = ['next', 'react', 'typescript', '@types/node', 'vite', 'astro', 'express', 'fastify', 'prisma', '@prisma/client'];

function sanitizeIdentifier(input: string, fallback: string): string {
    const value = input.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return value || fallback;
}

function normalizeProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseEnvValue(valueRaw: string): string {
    const value = valueRaw.trim();
    return ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        ? value.slice(1, -1)
        : value;
}

async function readEnvFile(filePath: string): Promise<ProjectBindingEnv> {
    const env: ProjectBindingEnv = {};
    const raw = await fsp.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index <= 0) continue;
        env[trimmed.slice(0, index).trim()] = parseEnvValue(trimmed.slice(index + 1));
    }
    return env;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) return null;
    try {
        return await fsp.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

function summarizeReadme(raw: string | null): string | null {
    if (!raw) return null;
    const summary = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && !/^[!\[]/.test(line))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!summary) return null;
    return summary.length > 280 ? `${summary.slice(0, 277)}...` : summary;
}

function detectPackageManager(projectPath: string, packageJson: Record<string, unknown> | null): string | null {
    const explicit = typeof packageJson?.packageManager === 'string' ? packageJson.packageManager.trim() : '';
    if (explicit) return explicit;
    if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(projectPath, 'package-lock.json'))) return 'npm';
    if (fs.existsSync(path.join(projectPath, 'bun.lockb')) || fs.existsSync(path.join(projectPath, 'bun.lock'))) return 'bun';
    return packageJson ? 'npm' : null;
}

function pickDependencyHighlights(packageJson: Record<string, unknown> | null): string[] {
    const deps = packageJson && typeof packageJson.dependencies === 'object' && packageJson.dependencies
        ? Object.keys(packageJson.dependencies as Record<string, unknown>)
        : [];
    const devDeps = packageJson && typeof packageJson.devDependencies === 'object' && packageJson.devDependencies
        ? Object.keys(packageJson.devDependencies as Record<string, unknown>)
        : [];
    const seen = new Set<string>();
    return [...deps, ...devDeps].filter((name) => {
        if (!HIGHLIGHT_PACKAGES.includes(name) || seen.has(name)) return false;
        seen.add(name);
        return true;
    }).slice(0, 8);
}

function detectFrameworks(packageJson: Record<string, unknown> | null): string[] {
    const deps = packageJson && typeof packageJson.dependencies === 'object' && packageJson.dependencies
        ? Object.keys(packageJson.dependencies as Record<string, unknown>)
        : [];
    const devDeps = packageJson && typeof packageJson.devDependencies === 'object' && packageJson.devDependencies
        ? Object.keys(packageJson.devDependencies as Record<string, unknown>)
        : [];
    const installed = new Set([...deps, ...devDeps]);
    return KNOWN_FRAMEWORKS.filter((name) => installed.has(name));
}

function detectLanguages(projectPath: string, packageJson: Record<string, unknown> | null, manifests: ProjectSnapshot['manifests']): string[] {
    const languages = new Set<string>();
    if (packageJson || manifests.jsconfig) languages.add('javascript');
    if (manifests.tsconfig || pickDependencyHighlights(packageJson).includes('typescript')) languages.add('typescript');
    if (manifests.pyprojectToml || manifests.requirementsTxt) languages.add('python');
    if (manifests.prismaSchema) languages.add('prisma');
    if (fs.existsSync(path.join(projectPath, 'go.mod'))) languages.add('go');
    return Array.from(languages);
}

function listSourceDirectories(projectPath: string): string[] {
    return SOURCE_DIRECTORIES.filter((dir) => {
        try {
            return fs.statSync(path.join(projectPath, dir)).isDirectory();
        } catch {
            return false;
        }
    });
}

function listSourceFiles(projectPath: string, manifests: ProjectSnapshot['manifests']): string[] {
    const files: string[] = [];
    if (manifests.packageJson) files.push('package.json');
    if (manifests.tsconfig) files.push('tsconfig.json');
    if (manifests.jsconfig) files.push('jsconfig.json');
    if (manifests.pyprojectToml) files.push('pyproject.toml');
    if (manifests.requirementsTxt) files.push('requirements.txt');
    if (manifests.readme) files.push('README.md');
    if (manifests.prismaSchema) files.push(path.join('prisma', 'schema.prisma'));
    if (fs.existsSync(path.join(projectPath, 'docker-compose.yml'))) files.push('docker-compose.yml');
    else if (fs.existsSync(path.join(projectPath, 'docker-compose.yaml'))) files.push('docker-compose.yaml');
    return files;
}

async function buildProjectSnapshot(projectPath: string, codebaseEntity: string): Promise<ProjectSnapshot> {
    const resolvedProjectPath = path.resolve(projectPath);
    const packageJsonPath = path.join(resolvedProjectPath, 'package.json');
    const packageJson = await readJsonIfExists<Record<string, unknown>>(packageJsonPath);
    const manifests = {
        packageJson: Boolean(packageJson),
        tsconfig: fs.existsSync(path.join(resolvedProjectPath, 'tsconfig.json')),
        jsconfig: fs.existsSync(path.join(resolvedProjectPath, 'jsconfig.json')),
        pyprojectToml: fs.existsSync(path.join(resolvedProjectPath, 'pyproject.toml')),
        requirementsTxt: fs.existsSync(path.join(resolvedProjectPath, 'requirements.txt')),
        readme: fs.existsSync(path.join(resolvedProjectPath, 'README.md')),
        prismaSchema: fs.existsSync(path.join(resolvedProjectPath, 'prisma', 'schema.prisma')),
        dockerCompose: fs.existsSync(path.join(resolvedProjectPath, 'docker-compose.yml')) || fs.existsSync(path.join(resolvedProjectPath, 'docker-compose.yaml')),
    };
    const packageScripts = packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts
        ? Object.keys(packageJson.scripts as Record<string, unknown>).slice(0, 16)
        : [];

    return {
        projectName: typeof packageJson?.name === 'string' && packageJson.name.trim().length > 0 ? packageJson.name.trim() : path.basename(resolvedProjectPath),
        projectPath: resolvedProjectPath,
        codebaseEntity,
        boundary: 'Bounded initial project snapshot from authoritative files during project bind. This is not a crawler, watcher, or autonomous full-repo understanding pass.',
        learnedAt: new Date().toISOString(),
        packageManager: detectPackageManager(resolvedProjectPath, packageJson),
        languages: detectLanguages(resolvedProjectPath, packageJson, manifests),
        frameworks: detectFrameworks(packageJson),
        dependencyHighlights: pickDependencyHighlights(packageJson),
        manifests,
        sourceDirectories: listSourceDirectories(resolvedProjectPath),
        packageScripts,
        readmeSummary: summarizeReadme(await readTextIfExists(path.join(resolvedProjectPath, 'README.md'))),
        sourceFiles: listSourceFiles(resolvedProjectPath, manifests),
    };
}

function formatOverviewSummary(snapshot: ProjectSnapshot): string {
    const descriptors = [snapshot.frameworks.join(', '), snapshot.languages.join(', ')].filter(Boolean).join('; ');
    const packageManager = snapshot.packageManager ? `package manager ${snapshot.packageManager}` : null;
    const parts = [descriptors || 'no framework or language hints detected yet', packageManager, snapshot.readmeSummary ? `README says ${snapshot.readmeSummary}` : null].filter(Boolean);
    return `Initial project snapshot for ${snapshot.projectName}: ${parts.join('; ')}.`;
}

function formatScriptsSummary(snapshot: ProjectSnapshot): string {
    return snapshot.packageScripts.length > 0
        ? `Project scripts for ${snapshot.projectName} include ${snapshot.packageScripts.join(', ')}.`
        : `Project scripts for ${snapshot.projectName} were not detected from package.json.`;
}

function formatLayoutSummary(snapshot: ProjectSnapshot): string {
    const manifests = Object.entries(snapshot.manifests).filter(([, present]) => present).map(([name]) => name);
    const sourceDirs = snapshot.sourceDirectories.length > 0 ? snapshot.sourceDirectories.join(', ') : 'no common source directories detected';
    return `Project layout for ${snapshot.projectName} includes ${sourceDirs}; manifests ${manifests.join(', ') || 'none detected'}.`;
}

function formatBindingSummary(snapshot: ProjectSnapshot, binding: ProjectBindingEnv): string {
    const memoryEntity = binding.IRANTI_MEMORY_ENTITY?.trim() || 'unknown';
    const agentId = binding.IRANTI_AGENT_ID?.trim() || 'unknown';
    const mode = binding.IRANTI_PROJECT_MODE?.trim() || 'isolated';
    return `Bound project ${snapshot.projectName} maps to ${snapshot.codebaseEntity} via agent ${agentId} in ${mode} mode; project memory entity is ${memoryEntity}.`;
}

export function deriveProjectCodebaseEntity(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    const base = sanitizeIdentifier(path.basename(resolved), 'project');
    const suffix = createHash('sha1').update(normalizeProjectPath(resolved)).digest('hex').slice(0, 8);
    return `codebase/${base}_${suffix}`;
}

export async function writeProjectLearningSnapshot(input: {
    projectPath: string;
    binding?: ProjectBindingEnv;
    projectEnvFile?: string | null;
    agentId?: string;
}): Promise<ProjectLearningStatus> {
    const resolvedProjectPath = path.resolve(input.projectPath);
    const binding = input.binding ?? (input.projectEnvFile?.trim() ? await readEnvFile(input.projectEnvFile.trim()) : null);
    if (!binding) {
        return { status: 'skipped', detail: 'project binding was not provided', entity: null, keys: [] };
    }

    const codebaseEntity = binding.IRANTI_CODEBASE_ENTITY?.trim() || deriveProjectCodebaseEntity(resolvedProjectPath);
    const instanceEnvFile = binding.IRANTI_INSTANCE_ENV?.trim();
    if (!instanceEnvFile) {
        return { status: 'skipped', detail: 'binding is missing IRANTI_INSTANCE_ENV', entity: codebaseEntity, keys: [] };
    }
    if (!fs.existsSync(instanceEnvFile)) {
        return { status: 'skipped', detail: 'instance env file not found', entity: codebaseEntity, keys: [] };
    }

    try {
        const instanceEnv = await readEnvFile(instanceEnvFile);
        const connectionString = instanceEnv.DATABASE_URL?.trim();
        if (!connectionString) {
            return { status: 'skipped', detail: 'instance env is missing DATABASE_URL', entity: codebaseEntity, keys: [] };
        }

        const snapshot = await buildProjectSnapshot(resolvedProjectPath, codebaseEntity);
        const agentId = input.agentId?.trim() || binding.IRANTI_AGENT_ID?.trim() || 'iranti_cli_project_learning';
        const iranti = createFirstPartyIranti({
            connectionString,
            llmProvider: instanceEnv.LLM_PROVIDER,
            sessionLedgerSource: 'cli',
            sessionLedgerHost: 'plain_cli',
            sessionLedgerAgentId: agentId,
        });

        const writes: Array<{ key: string; value: unknown; summary: string; durableClass: string; extraTags: string[] }> = [
            {
                key: 'project_overview',
                value: {
                    projectName: snapshot.projectName,
                    projectPath: snapshot.projectPath,
                    codebaseEntity: snapshot.codebaseEntity,
                    boundary: snapshot.boundary,
                    learnedAt: snapshot.learnedAt,
                    packageManager: snapshot.packageManager,
                    languages: snapshot.languages,
                    frameworks: snapshot.frameworks,
                    dependencyHighlights: snapshot.dependencyHighlights,
                    readmeSummary: snapshot.readmeSummary,
                },
                summary: formatOverviewSummary(snapshot),
                durableClass: 'project_snapshot',
                extraTags: ['overview', 'binding'],
            },
            {
                key: 'project_scripts',
                value: {
                    projectName: snapshot.projectName,
                    packageScripts: snapshot.packageScripts,
                    learnedAt: snapshot.learnedAt,
                    sourceFiles: snapshot.manifests.packageJson ? ['package.json'] : [],
                },
                summary: formatScriptsSummary(snapshot),
                durableClass: 'project_snapshot',
                extraTags: ['scripts', 'binding'],
            },
            {
                key: 'project_layout',
                value: {
                    projectName: snapshot.projectName,
                    manifests: snapshot.manifests,
                    sourceDirectories: snapshot.sourceDirectories,
                    sourceFiles: snapshot.sourceFiles,
                    learnedAt: snapshot.learnedAt,
                },
                summary: formatLayoutSummary(snapshot),
                durableClass: 'project_snapshot',
                extraTags: ['layout', 'binding'],
            },
            {
                key: 'project_binding',
                value: {
                    projectPath: snapshot.projectPath,
                    codebaseEntity: snapshot.codebaseEntity,
                    memoryEntity: binding.IRANTI_MEMORY_ENTITY?.trim() || null,
                    personalMemoryEntity: binding.IRANTI_PERSONAL_MEMORY_ENTITY?.trim() || null,
                    agentId: binding.IRANTI_AGENT_ID?.trim() || null,
                    projectMode: binding.IRANTI_PROJECT_MODE?.trim() || null,
                    instance: binding.IRANTI_INSTANCE?.trim() || null,
                    instanceEnvFile,
                    learnedAt: snapshot.learnedAt,
                },
                summary: formatBindingSummary(snapshot, binding),
                durableClass: 'project_binding',
                extraTags: ['binding', 'codebase-entity'],
            },
        ];

        for (const write of writes) {
            await iranti.write({
                entity: codebaseEntity,
                key: write.key,
                value: write.value,
                summary: write.summary,
                confidence: 90,
                source: 'ProjectBindingLearning',
                agent: agentId,
                properties: {
                    memoryScope: 'project',
                    capturePhase: 'bind',
                    durableClass: write.durableClass,
                    canonicalKey: write.key,
                    mergeStrategy: 'replace',
                    ...buildSemanticFactTags({
                        memoryScope: 'project',
                        durableClass: write.durableClass,
                        mergeStrategy: 'replace',
                        extraTags: ['project-learning', ...write.extraTags],
                    }),
                },
            });
        }

        return {
            status: 'written',
            detail: `bounded project snapshot written to ${codebaseEntity}`,
            entity: codebaseEntity,
            keys: writes.map((write) => write.key),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'failed', detail: message, entity: codebaseEntity, keys: [] };
    } finally {
        await disconnectDb().catch(() => undefined);
    }
}
