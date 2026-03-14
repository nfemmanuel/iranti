import fs from 'node:fs';
import path from 'node:path';

function readText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, 'utf8');
}

function assertSemver(raw: string | undefined): string {
    const value = raw?.trim();
    if (!value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
        throw new Error('Usage: npm run release:bump -- <version>. Example: npm run release:bump -- 0.1.1');
    }
    return value;
}

function nextPatch(version: string): string {
    const [major, minor, patchWithSuffix] = version.split('.');
    const patch = Number.parseInt((patchWithSuffix ?? '0').split('-')[0], 10);
    return `${major}.${minor}.${patch + 1}`;
}

function replaceOrThrow(source: string, search: RegExp, replacement: string, label: string): string {
    if (!search.test(source)) {
        throw new Error(`Could not update ${label}.`);
    }
    return source.replace(search, replacement);
}

function replaceAllLiteral(source: string, search: string, replacement: string): string {
    return source.split(search).join(replacement);
}

function main(): void {
    const repoRoot = path.resolve(__dirname, '..');
    const targetVersion = assertSemver(process.argv[2]);

    const packageJsonPath = path.join(repoRoot, 'package.json');
    const packageLockPath = path.join(repoRoot, 'package-lock.json');
    const tsClientPackagePath = path.join(repoRoot, 'clients', 'typescript', 'package.json');
    const pyProjectPath = path.join(repoRoot, 'clients', 'python', 'pyproject.toml');
    const pyClientPath = path.join(repoRoot, 'clients', 'python', 'iranti.py');
    const apiServerPath = path.join(repoRoot, 'src', 'api', 'server.ts');
    const seedPath = path.join(repoRoot, 'scripts', 'seed.ts');
    const mcpPath = path.join(repoRoot, 'scripts', 'iranti-mcp.ts');
    const releaseGuidePath = path.join(repoRoot, 'docs', 'guides', 'releasing.md');
    const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

    const packageJson = JSON.parse(readText(packageJsonPath)) as { version: string };
    const currentVersion = packageJson.version;
    const targetNextPatch = nextPatch(targetVersion);

    packageJson.version = targetVersion;
    writeText(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    const tsClientPackage = JSON.parse(readText(tsClientPackagePath)) as { version: string };
    tsClientPackage.version = targetVersion;
    writeText(tsClientPackagePath, `${JSON.stringify(tsClientPackage, null, 2)}\n`);

    const packageLock = JSON.parse(readText(packageLockPath)) as {
        version?: string;
        packages?: Record<string, { version?: string }>;
    };
    packageLock.version = targetVersion;
    if (packageLock.packages?.['']) {
        packageLock.packages[''].version = targetVersion;
    }
    writeText(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

    writeText(pyProjectPath, replaceOrThrow(
        readText(pyProjectPath),
        /^\s*version\s*=\s*"[^"]+"/m,
        `version = "${targetVersion}"`,
        'clients/python/pyproject.toml version',
    ));

    writeText(pyClientPath, replaceOrThrow(
        readText(pyClientPath),
        /__version__\s*=\s*"[^"]+"/,
        `__version__ = "${targetVersion}"`,
        'clients/python/iranti.py __version__',
    ));

    writeText(apiServerPath, replaceOrThrow(
        readText(apiServerPath),
        /version:\s*'[^']+'/,
        `version: '${targetVersion}'`,
        'src/api/server.ts health version',
    ));

    writeText(seedPath, replaceAllLiteral(readText(seedPath), currentVersion, targetVersion));

    writeText(mcpPath, replaceOrThrow(
        readText(mcpPath),
        /version:\s*'[^']+'/,
        `version: '${targetVersion}'`,
        'scripts/iranti-mcp.ts version',
    ));

    const releaseGuide = readText(releaseGuidePath)
        .replace(/Current repo version is `[^`]+`\./, `Current repo version is \`${targetVersion}\`.`)
        .replace(/If the next release is `[^`]+`/, `If the next release is \`${targetNextPatch}\``)
        .replace(/npm run release:bump -- [^\n]+/, `npm run release:bump -- ${targetNextPatch}`)
        .replace(/npm run release:check -- v[^\n]+/, `npm run release:check -- v${targetNextPatch}`)
        .replace(/git commit -m "Release v[^"]+"/, `git commit -m "Release v${targetNextPatch}"`)
        .replace(/git tag v[^\n]+/, `git tag v${targetNextPatch}`)
        .replace(/git push origin v[^\n]+/, `git push origin v${targetNextPatch}`)
        .replace(/gh release create v[^\n]+ --title "v[^"]+"/, `gh release create v${targetNextPatch} --title "v${targetNextPatch}"`);
    writeText(releaseGuidePath, releaseGuide);

    const changelog = readText(changelogPath);
    if (!changelog.includes(`## ${targetVersion} - Unreleased`)) {
        const insertion = `## ${targetVersion} - Unreleased\n\n### Added\n\n- Pending release notes.\n\n`;
        writeText(changelogPath, changelog.replace('# Changelog\n\nAll notable changes to this project are documented in this file.\n\n', `# Changelog\n\nAll notable changes to this project are documented in this file.\n\n${insertion}`));
    }

    console.log(`Version bumped from ${currentVersion} to ${targetVersion}`);
}

main();
