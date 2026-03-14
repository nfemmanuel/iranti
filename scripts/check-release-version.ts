import fs from 'fs';
import path from 'path';

type VersionSnapshot = {
    nodePackage: string;
    pythonProject: string;
    pythonClient: string;
};

function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

function extractPythonClientVersion(source: string): string {
    const match = source.match(/__version__\s*=\s*"([^"]+)"/);
    if (!match) {
        throw new Error('Could not find __version__ in clients/python/iranti.py');
    }
    return match[1];
}

function extractTomlVersion(source: string): string {
    const match = source.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (!match) {
        throw new Error('Could not find version in clients/python/pyproject.toml');
    }
    return match[1];
}

function loadVersions(rootDir: string): VersionSnapshot {
    const packageJson = readJson(path.join(rootDir, 'package.json'));
    const pyproject = readText(path.join(rootDir, 'clients', 'python', 'pyproject.toml'));
    const pythonClient = readText(path.join(rootDir, 'clients', 'python', 'iranti.py'));

    return {
        nodePackage: String(packageJson.version),
        pythonProject: extractTomlVersion(pyproject),
        pythonClient: extractPythonClientVersion(pythonClient),
    };
}

function normalizeTagVersion(raw?: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    return value.startsWith('v') ? value.slice(1) : value;
}

function assertVersionsMatch(versions: VersionSnapshot): void {
    const values = Object.values(versions);
    const unique = new Set(values);
    if (unique.size !== 1) {
        throw new Error(
            `Version mismatch detected: package.json=${versions.nodePackage}, `
            + `clients/python/pyproject.toml=${versions.pythonProject}, `
            + `clients/python/iranti.py=${versions.pythonClient}`
        );
    }
}

function main(): void {
    const rootDir = process.cwd();
    const versions = loadVersions(rootDir);
    assertVersionsMatch(versions);

    const releaseTag = normalizeTagVersion(
        process.env.RELEASE_TAG
        ?? process.env.GITHUB_REF_NAME
        ?? process.argv[2]
    );

    if (releaseTag && releaseTag !== versions.nodePackage) {
        throw new Error(`Release tag version (${releaseTag}) does not match package version (${versions.nodePackage}).`);
    }

    console.log(`Release version verified: ${versions.nodePackage}`);
}

main();
