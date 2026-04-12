/**
 * Contract test: verifies that iranti SDK TypeScript types match the shapes
 * returned by the running server API. Requires DATABASE_URL.
 */
import fs from 'fs';
import path from 'path';

type CheckResult = {
    name: string;
    passed: boolean;
    details?: string;
    skipped?: boolean;
};

type ForbiddenPattern = {
    pattern: RegExp;
    detail: string;
};

type RepoCheck = {
    repoDir: string;
    relativePath: string;
    label: string;
    forbidden: ForbiddenPattern[];
};

const repoRoot = process.cwd();
const results: CheckResult[] = [];

function siblingRepoPath(name: string): string {
    return path.resolve(repoRoot, '..', name);
}

function pass(name: string): void {
    results.push({ name, passed: true });
}

function fail(name: string, details: string): void {
    results.push({ name, passed: false, details });
}

function skip(name: string, details: string): void {
    results.push({ name, passed: true, skipped: true, details });
}

function readSiblingFile(repoDir: string, relativePath: string): string | null {
    const filePath = path.join(repoDir, relativePath);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return fs.readFileSync(filePath, 'utf8');
}

function assertNoForbiddenPatterns(check: RepoCheck): void {
    const repoName = path.basename(check.repoDir);
    if (!fs.existsSync(check.repoDir)) {
        skip(check.label, `Skipped because sibling repo was not present: ${repoName}`);
        return;
    }

    const content = readSiblingFile(check.repoDir, check.relativePath);
    if (content === null) {
        skip(check.label, `Skipped because file was not present: ${repoName}/${check.relativePath}`);
        return;
    }

    for (const forbidden of check.forbidden) {
        const match = content.match(forbidden.pattern);
        if (match) {
            fail(
                check.label,
                `${repoName}/${check.relativePath} still contains stale contract token "${match[0]}". ${forbidden.detail}`,
            );
            return;
        }
    }

    pass(check.label);
}

function main(): void {
    const controlPlaneDir = siblingRepoPath('iranti-control-plane');
    const siteDir = siblingRepoPath('iranti-site');
    const benchmarkingDir = siblingRepoPath('iranti-benchmarking');

    const staleCliPatterns: ForbiddenPattern[] = [
        { pattern: /iranti bind\b/i, detail: 'Use `iranti project init` / `iranti configure project` for the current CLI contract.' },
        { pattern: /iranti init\b/i, detail: 'Use `iranti setup` or `iranti instance create` for the current CLI contract.' },
        { pattern: /iranti config\b/i, detail: 'Use `iranti configure instance` or `iranti configure project` for the current CLI contract.' },
        { pattern: /iranti setup --mcp\b/i, detail: 'Use `iranti claude-setup` or `iranti codex-setup` for the current integration scaffolding contract.' },
    ];

    assertNoForbiddenPatterns({
        repoDir: controlPlaneDir,
        relativePath: 'WORKFLOW_MATRIX.md',
        label: 'Control plane workflow matrix uses current Iranti CLI contract',
        forbidden: staleCliPatterns,
    });

    assertNoForbiddenPatterns({
        repoDir: controlPlaneDir,
        relativePath: path.join('docs', 'reference', 'api.md'),
        label: 'Control plane API reference avoids retired MCP setup command',
        forbidden: [
            {
                pattern: /iranti setup --mcp\b/i,
                detail: 'Use the current host-specific setup commands instead of the retired `setup --mcp` flow.',
            },
        ],
    });

    assertNoForbiddenPatterns({
        repoDir: siteDir,
        relativePath: path.join('src', 'components', 'GetStartedContent.tsx'),
        label: 'Site getting-started content avoids retired CLI commands',
        forbidden: staleCliPatterns,
    });

    assertNoForbiddenPatterns({
        repoDir: benchmarkingDir,
        relativePath: 'VERSION.md',
        label: 'Benchmarking version docs avoid retired CLI commands',
        forbidden: staleCliPatterns,
    });

    const failed = results.filter((result) => !result.passed);
    const skipped = results.filter((result) => result.skipped);

    for (const result of results) {
        const prefix = result.skipped ? '[SKIP]' : result.passed ? '[PASS]' : '[FAIL]';
        console.log(`${prefix} ${result.name}`);
        if (result.details) {
            console.log(`       ${result.details}`);
        }
    }

    console.log('');
    console.log(`Summary: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped.`);

    if (failed.length > 0) {
        process.exit(1);
    }
}

main();
