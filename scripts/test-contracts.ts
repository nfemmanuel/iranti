import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

type CheckResult = {
    name: string;
    passed: boolean;
    details?: string;
};

const results: CheckResult[] = [];

function projectPath(relativePath: string): string {
    return path.join(process.cwd(), relativePath);
}

function readFile(relativePath: string): string {
    return fs.readFileSync(projectPath(relativePath), 'utf8');
}

function collectFiles(relativePath: string): string[] {
    const root = projectPath(relativePath);
    if (!fs.existsSync(root)) {
        return [];
    }

    const results: string[] = [];
    const stack: string[] = [root];

    while (stack.length > 0) {
        const current = stack.pop()!;
        const stat = fs.statSync(current);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(current)) {
                if (
                    entry === 'node_modules' ||
                    entry === 'dist' ||
                    entry === '.git' ||
                    entry === '__pycache__' ||
                    entry === 'venv' ||
                    entry === '.venv' ||
                    entry === '.venv-smoke' ||
                    entry === 'site-packages' ||
                    entry.endsWith('.egg-info') ||
                    entry.endsWith('.dist-info')
                ) {
                    continue;
                }
                stack.push(path.join(current, entry));
            }
            continue;
        }

        results.push(path.relative(process.cwd(), current).replace(/\\/g, '/'));
    }

    return results;
}

function pass(name: string): void {
    results.push({ name, passed: true });
}

function fail(name: string, details: string): void {
    results.push({ name, passed: false, details });
}

function expectIncludes(filePath: string, content: string, token: string, label: string): void {
    if (content.includes(token)) {
        pass(label);
        return;
    }
    fail(label, `${filePath} is missing token: ${token}`);
}

function expectRegex(filePath: string, content: string, pattern: RegExp, label: string): void {
    if (pattern.test(content)) {
        pass(label);
        return;
    }
    fail(label, `${filePath} did not match pattern: ${pattern}`);
}

function expectNotRegex(filePath: string, content: string, pattern: RegExp, label: string): void {
    if (!pattern.test(content)) {
        pass(label);
        return;
    }
    fail(label, `${filePath} matched forbidden pattern: ${pattern}`);
}

function assertServerRouteMounts(): void {
    const filePath = 'src/api/server.ts';
    const content = readFile(filePath);

    expectRegex(
        filePath,
        content,
        /app\.use\(ROUTES\.agents,\s*authenticate,\s*rateLimitMiddleware,\s*requireScopeByMethod\('agents:read',\s*'agents:write'\),\s*agentRoutes\(iranti\)\);/,
        'Server mounts /agents with auth + rate limit'
    );
    expectRegex(
        filePath,
        content,
        /app\.use\(ROUTES\.kb,\s*authenticate,\s*rateLimitMiddleware,\s*requireScopeFamilyByMethod\('kb:read',\s*'kb:write'\),\s*knowledgeRoutes\(iranti\)\);/,
        'Server mounts /kb with auth + rate limit'
    );
    expectRegex(
        filePath,
        content,
        /app\.use\(ROUTES\.memory,\s*authenticate,\s*rateLimitMiddleware,\s*requireScopeByMethod\('memory:read',\s*'memory:write'\),\s*memoryRoutes\(iranti\)\);/,
        'Server mounts /memory with auth + rate limit'
    );
    expectRegex(
        filePath,
        content,
        /app\.use\('\/kb\/batchQuery',\s*authenticate,\s*rateLimitMiddleware,\s*requireAnyScope\(\['kb:read'\]\),\s*batchRouter\);/,
        'Server mounts /kb batch router with rate limit'
    );
}

function assertKnowledgeRoutes(): void {
    const filePath = 'src/api/routes/knowledge.ts';
    const content = readFile(filePath);

    expectIncludes(filePath, content, "router.post('/write', validateInput('write')", 'Knowledge route: POST /write uses validation');
    expectIncludes(filePath, content, "router.post('/ingest'", 'Knowledge route: POST /ingest');
    expectIncludes(filePath, content, "router.post('/resolve'", 'Knowledge route: POST /resolve');
    expectIncludes(filePath, content, "router.post('/alias'", 'Knowledge route: POST /alias');
    expectIncludes(filePath, content, "router.get('/entity/:entityType/:entityId/aliases'", 'Knowledge route: GET /entity/:type/:id/aliases');
    expectIncludes(filePath, content, "router.get('/query/:entityType/:entityId/:key'", 'Knowledge route: GET /query/:type/:id/:key');
    expectIncludes(filePath, content, "router.get('/query/:entityType/:entityId'", 'Knowledge route: GET /query/:type/:id');
    expectIncludes(filePath, content, "router.post('/relate', validateInput('relate')", 'Knowledge route: POST /relate uses validation');
    expectIncludes(filePath, content, "router.get('/related/:entityType/:entityId'", 'Knowledge route: GET /related/:type/:id');
    expectIncludes(filePath, content, "router.get('/related/:entityType/:entityId/deep'", 'Knowledge route: GET /related/:type/:id/deep');
}

function assertMemoryRoutes(): void {
    const filePath = 'src/api/routes/memory.ts';
    const content = readFile(filePath);

    expectIncludes(filePath, content, "router.post('/handshake', validateInput('handshake')", 'Memory route: POST /handshake uses validation');
    expectIncludes(filePath, content, "router.post('/reconvene', validateInput('reconvene')", 'Memory route: POST /reconvene uses validation');
    expectIncludes(filePath, content, "router.get('/sessions'", 'Memory route: GET /sessions');
    expectIncludes(filePath, content, "router.get('/session/:agentId'", 'Memory route: GET /session/:agentId');
    expectIncludes(filePath, content, "router.post('/checkpoint', validateInput('checkpoint')", 'Memory route: POST /checkpoint uses validation');
    expectIncludes(filePath, content, "router.post('/resume', validateInput('sessionAction')", 'Memory route: POST /resume uses validation');
    expectIncludes(filePath, content, "router.post('/complete', validateInput('sessionAction')", 'Memory route: POST /complete uses validation');
    expectIncludes(filePath, content, "router.post('/abandon', validateInput('sessionAction')", 'Memory route: POST /abandon uses validation');
    expectIncludes(filePath, content, "router.post('/observe', validateInput('observe')", 'Memory route: POST /observe uses validation');
    expectIncludes(filePath, content, "router.post('/attend', validateInput('attend')", 'Memory route: POST /attend uses validation');
    expectIncludes(filePath, content, "router.get('/whoknows/:entityType/:entityId'", 'Memory route: GET /whoknows/:type/:id');
    expectIncludes(filePath, content, "router.post('/maintenance'", 'Memory route: POST /maintenance');
}

function assertAgentRoutes(): void {
    const filePath = 'src/api/routes/agents.ts';
    const content = readFile(filePath);

    expectIncludes(filePath, content, "router.post('/register'", 'Agent route: POST /register');
    expectIncludes(filePath, content, "router.get('/',", 'Agent route: GET /');
    expectIncludes(filePath, content, "router.get('/:agentId'", 'Agent route: GET /:agentId');
    expectIncludes(filePath, content, "router.post('/:agentId/team'", 'Agent route: POST /:agentId/team');
}

function assertBatchRoute(): void {
    const filePath = 'src/api/routes/batch.ts';
    const content = readFile(filePath);

    expectRegex(filePath, content, /batchRouter\.post\((["'])\/\1/, 'Batch route: POST /kb/batchQuery');
}

function assertPythonClientContract(): void {
    const filePath = 'clients/python/iranti.py';
    const content = readFile(filePath);

    expectIncludes(filePath, content, "'http://localhost:3001'", 'Python client default URL is localhost:3001');
    expectIncludes(filePath, content, "self._post('/kb/write'", 'Python client writes to /kb/write');
    expectIncludes(filePath, content, "self._post('/kb/ingest'", 'Python client ingests to /kb/ingest');
    expectIncludes(filePath, content, "f'/kb/query/{entity_type}/{entity_id}/{key}'", 'Python client queries /kb/query/:type/:id/:key');
    expectIncludes(filePath, content, "f'/kb/history/{entity_type}/{entity_id}/{key}'", 'Python client queries /kb/history/:type/:id/:key');
    expectIncludes(filePath, content, "self._get(f'/kb/query/{entity_type}/{entity_id}')", 'Python client queries /kb/query/:type/:id');
    expectIncludes(filePath, content, "self._post('/kb/relate'", 'Python client relates via /kb/relate');
    expectIncludes(filePath, content, "self._get(f'/kb/related/{entity_type}/{entity_id}')", 'Python client reads /kb/related/:type/:id');
    expectIncludes(filePath, content, "self._get(f'/kb/related/{entity_type}/{entity_id}/deep?depth={depth}')", 'Python client reads /kb/related/:type/:id/deep');
    expectIncludes(filePath, content, "self._post('/memory/handshake'", 'Python client handshakes via /memory/handshake');
    expectIncludes(filePath, content, "self._post('/memory/reconvene'", 'Python client reconvenes via /memory/reconvene');
    expectIncludes(filePath, content, "self._post('/memory/checkpoint'", 'Python client checkpoints via /memory/checkpoint');
    expectIncludes(filePath, content, "self._post('/memory/resume'", 'Python client resumes via /memory/resume');
    expectIncludes(filePath, content, "self._post('/memory/complete'", 'Python client completes via /memory/complete');
    expectIncludes(filePath, content, "self._post('/memory/abandon'", 'Python client abandons via /memory/abandon');
    expectIncludes(filePath, content, "self._get('/memory/sessions' if not params else", 'Python client lists /memory/sessions');
    expectIncludes(filePath, content, "self._get(f'/memory/session/{agent_id}')", 'Python client inspects /memory/session/:agentId');
    expectIncludes(filePath, content, "self._post('/memory/attend'", 'Python client attends via /memory/attend');
    expectIncludes(filePath, content, "self._get(f'/memory/whoknows/{entity_type}/{entity_id}')", 'Python client reads /memory/whoknows/:type/:id');
    expectIncludes(filePath, content, "self._post('/memory/maintenance'", 'Python client calls /memory/maintenance');
    expectIncludes(filePath, content, "self._post('/memory/observe'", 'Python client observes via /memory/observe');
    expectIncludes(filePath, content, "self._post('/agents/register'", 'Python client registers via /agents/register');

    expectNotRegex(filePath, content, /self\._post\('\/write'/, 'Python client does not use deprecated /write route');
    expectNotRegex(filePath, content, /self\._post\('\/observe'/, 'Python client does not use deprecated /observe route');
    expectNotRegex(filePath, content, /self\._get\(f?'\/query\//, 'Python client does not use deprecated /query route');
}

function assertTypeScriptSdkSurface(): void {
    const filePath = 'src/sdk/index.ts';
    const content = readFile(filePath);

    const requiredMethods = [
        'async write(',
        'async ingest(',
        'async handshake(',
        'async reconvene(',
        'async checkpoint(',
        'async resumeSession(',
        'async completeSession(',
        'async abandonSession(',
        'async listSessions(',
        'async inspectSession(',
        'async attend(',
        'async query(',
        'async history(',
        'async queryAll(',
        'async runMaintenance(',
        'async relate(',
        'async getRelated(',
        'async getRelatedDeep(',
        'async registerAgent(',
        'async getAgent(',
        'async whoKnows(',
        'async listAgents(',
        'async assignToTeam(',
        'async observe(',
    ];

    for (const method of requiredMethods) {
        expectIncludes(filePath, content, method, `TS SDK includes method: ${method.replace('async ', '').replace('(', '')}`);
    }
}

function assertTypeScriptHttpClientContract(): void {
    const filePath = 'clients/typescript/src/client.ts';
    const content = readFile(filePath);

    expectIncludes(filePath, content, "'/kb/write'", 'TypeScript client writes to /kb/write');
    expectIncludes(filePath, content, "'/kb/ingest'", 'TypeScript client ingests to /kb/ingest');
    expectIncludes(filePath, content, '`/kb/query/${entityType}/${entityId}/${key}${query}`', 'TypeScript client queries /kb/query/:type/:id/:key');
    expectIncludes(filePath, content, '`/kb/query/${entityType}/${entityId}`', 'TypeScript client queries /kb/query/:type/:id');
    expectIncludes(filePath, content, "'/kb/relate'", 'TypeScript client relates via /kb/relate');
    expectIncludes(filePath, content, "'/memory/handshake'", 'TypeScript client handshakes via /memory/handshake');
    expectIncludes(filePath, content, "'/memory/reconvene'", 'TypeScript client reconvenes via /memory/reconvene');
    expectIncludes(filePath, content, "'/memory/checkpoint'", 'TypeScript client checkpoints via /memory/checkpoint');
    expectIncludes(filePath, content, "'/memory/resume'", 'TypeScript client resumes via /memory/resume');
    expectIncludes(filePath, content, "'/memory/complete'", 'TypeScript client completes via /memory/complete');
    expectIncludes(filePath, content, "'/memory/abandon'", 'TypeScript client abandons via /memory/abandon');
    expectRegex(filePath, content, /'GET',\s*`?\/memory\/sessions/, 'TypeScript client lists /memory/sessions');
    expectIncludes(filePath, content, "'GET', `/memory/session/${params.agentId}`", 'TypeScript client inspects /memory/session/:agentId');
    expectIncludes(filePath, content, "'/memory/attend'", 'TypeScript client attends via /memory/attend');
    expectIncludes(filePath, content, "'/memory/observe'", 'TypeScript client observes via /memory/observe');
    expectIncludes(filePath, content, '`/memory/whoknows/${entityType}/${entityId}`', 'TypeScript client reads /memory/whoknows/:type/:id');
    expectIncludes(filePath, content, "'/memory/maintenance'", 'TypeScript client calls /memory/maintenance');
    expectIncludes(filePath, content, "'/agents/register'", 'TypeScript client registers via /agents/register');

    expectNotRegex(filePath, content, /['"`]\/write['"`]/, 'TypeScript client does not use deprecated /write route');
    expectNotRegex(filePath, content, /['"`]\/observe['"`]/, 'TypeScript client does not use deprecated /observe route');
}

function assertApiDocsContract(): void {
    const filePath = 'docs/API.md';
    const content = readFile(filePath);

    const requiredRoutes = [
        '- `POST /kb/write`',
        '- `POST /kb/ingest`',
        '- `GET /kb/query/:entityType/:entityId/:key`',
        '- `GET /kb/query/:entityType/:entityId`',
        '- `POST /kb/relate`',
        '- `POST /memory/handshake`',
        '- `POST /memory/reconvene`',
        '- `GET /memory/sessions`',
        '- `GET /memory/session/:agentId`',
        '- `POST /memory/checkpoint`',
        '- `POST /memory/resume`',
        '- `POST /memory/complete`',
        '- `POST /memory/abandon`',
        '- `POST /memory/attend`',
        '- `POST /memory/observe`',
        '- `GET /memory/whoknows/:entityType/:entityId`',
        '- `POST /agents/register`',
    ];

    for (const route of requiredRoutes) {
        expectIncludes(filePath, content, route, `API docs include ${route}`);
    }
}

function assertCliGuideContracts(): void {
    const cliFilePath = 'scripts/iranti-cli.ts';
    const cliContent = readFile(cliFilePath);
    const helpRendererPath = 'src/lib/cliHelpRenderer.ts';
    const helpRendererContent = readFile(helpRendererPath);
    expectIncludes(cliFilePath, cliContent, 'iranti handoff task/<task_id>', 'CLI help includes iranti handoff');
    expectIncludes(helpRendererPath, helpRendererContent, 'Use this when:', 'CLI help source includes use-case guidance');
    expectIncludes(helpRendererPath, helpRendererContent, 'Setup Option Guide', 'Setup help includes option guidance section');
    expectIncludes(cliFilePath, cliContent, 'Runtime Mode Choices', 'Setup wizard source includes runtime mode guidance');
    expectIncludes(cliFilePath, cliContent, 'Project Binding', 'Setup wizard source includes project binding guidance');
    expectIncludes(cliFilePath, cliContent, 'Interactive Instance Configuration', 'Configure instance source includes interactive guidance');
    expectIncludes(cliFilePath, cliContent, 'Interactive Project Configuration', 'Configure project source includes interactive guidance');

    const helpOutput = execFileSync('node', ['bin/iranti.js', '--help'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    if (helpOutput.includes('Use this when:') && helpOutput.includes('Typical scenario:')) {
        pass('CLI help output includes use-case guidance');
    } else {
        fail('CLI help output includes use-case guidance', 'Expected `node bin/iranti.js --help` to include "Use this when:" and "Typical scenario:".');
    }

    const setupHelpOutput = execFileSync('node', ['bin/iranti.js', 'setup', '--help'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    if (setupHelpOutput.includes('Setup Option Guide') && setupHelpOutput.includes('--mode isolated|shared')) {
        pass('Setup help output includes option guidance');
    } else {
        fail('Setup help output includes option guidance', 'Expected `node bin/iranti.js setup --help` to include the setup option guide.');
    }

    const quickstartPath = 'docs/guides/quickstart.md';
    const quickstartContent = readFile(quickstartPath);
    expectIncludes(quickstartPath, quickstartContent, 'iranti handoff task/runtime_verification_pass', 'Quickstart documents iranti handoff');
    expectIncludes(quickstartPath, quickstartContent, 'what it does and when to use it', 'Quickstart points users to richer CLI help');

    const manualPath = 'docs/guides/manual.md';
    const manualContent = readFile(manualPath);
    expectIncludes(manualPath, manualContent, 'Write shared Codex/Claude handoff state', 'Manual command table includes iranti handoff');
    expectIncludes(manualPath, manualContent, '[Cross-Tool Handoffs](./cross-tool-handoffs.md)', 'Manual links to cross-tool handoff guide');
    expectIncludes(manualPath, manualContent, 'CLI help now includes short "what it does" and "use this when" guidance', 'Manual points users to richer CLI help');

    const readmePath = 'README.md';
    const readmeContent = readFile(readmePath);
    expectIncludes(readmePath, readmeContent, 'Operator-facing CLI help now includes short "what it does" and "use this when" guidance', 'README points users to richer CLI help');
}

function assertPlaceholderHygiene(): void {
    const bannedTokens = [
        ['your', 'key', 'here'].join('_'),
        ['your', 'openai', 'key'].join('_'),
        ['dev', 'test', 'key', '12345'].join('_'),
        ['dev', 'benchmark', 'key'].join('-'),
    ];
    const bannedPatterns = [
        /\bsk-(?:ant-)?\.\.\.\b/,
        /\bsk-your-openai-key\b/,
        /\bsk-ant-your-claude-key\b/,
    ];
    const scanTargets = [
        'README.md',
        ...collectFiles('docs'),
        ...collectFiles('tests'),
        ...collectFiles('clients'),
        ...collectFiles('scripts'),
        ...collectFiles('experiments'),
    ].filter((filePath) => filePath !== 'scripts/test-contracts.ts' && filePath !== 'scripts/iranti-cli.ts');
    const violations: string[] = [];

    for (const filePath of new Set(scanTargets)) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext && !['.md', '.py', '.ts', '.js', '.json', '.toml', '.txt', '.yml', '.yaml'].includes(ext)) {
            continue;
        }

        const content = readFile(filePath);
        for (const token of bannedTokens) {
            if (content.includes(token)) {
                violations.push(`${filePath} contains banned placeholder token: ${token}`);
            }
        }
        for (const pattern of bannedPatterns) {
            if (pattern.test(content)) {
                violations.push(`${filePath} matches banned placeholder pattern: ${pattern}`);
            }
        }
    }

    if (violations.length === 0) {
        pass('Docs and examples avoid risky placeholder tokens');
    } else {
        fail('Docs and examples avoid risky placeholder tokens', violations.slice(0, 10).join('; '));
    }

    const gitleaksPath = '.gitleaks.toml';
    const gitleaksContent = readFile(gitleaksPath);
    expectNotRegex(gitleaksPath, gitleaksContent, /\bsk-your-openai-key\b/, 'gitleaks does not allowlist old OpenAI key placeholder');
    expectNotRegex(gitleaksPath, gitleaksContent, /\bsk-ant-your-claude-key\b/, 'gitleaks does not allowlist old Anthropic key placeholder');
    expectNotRegex(gitleaksPath, gitleaksContent, /\bsk-(?:ant-)?\.\.\.\b/, 'gitleaks does not allowlist key-like ellipsis placeholders');
}

function assertPackageMainPointsToBuiltFile(): void {
    const filePath = 'package.json';
    const packageJson = JSON.parse(readFile(filePath)) as { main?: string; files?: string[] };
    if (!packageJson.main) {
        fail('package.json has main field', 'package.json main field is missing');
        return;
    }

    const mainPath = packageJson.main;
    if (!fs.existsSync(projectPath(mainPath))) {
        fail('package.json main points to existing build output', `main="${mainPath}" does not exist on disk. Run npm run build before this check.`);
        return;
    }

    pass('package.json main points to existing build output');

    if (!Array.isArray(packageJson.files) || !packageJson.files.includes('prisma.config.ts')) {
        fail('package.json ships prisma.config.ts', 'package.json files[] must include prisma.config.ts so packaged setup can run Prisma migrations.');
        return;
    }

    pass('package.json ships prisma.config.ts');
}

function printSummaryAndExit(): never {
    const failed = results.filter((r) => !r.passed);
    const passed = results.length - failed.length;

    console.log('Contract checks:\n');
    for (const result of results) {
        if (result.passed) {
            console.log(`  [PASS] ${result.name}`);
        } else {
            console.log(`  [FAIL] ${result.name}`);
            if (result.details) {
                console.log(`         ${result.details}`);
            }
        }
    }

    console.log(`\nSummary: ${passed} passed, ${failed.length} failed`);
    if (failed.length > 0) {
        process.exit(1);
    }
    process.exit(0);
}

function main(): void {
    assertServerRouteMounts();
    assertKnowledgeRoutes();
    assertMemoryRoutes();
    assertAgentRoutes();
    assertBatchRoute();
    assertPythonClientContract();
    assertTypeScriptSdkSurface();
    assertTypeScriptHttpClientContract();
    assertApiDocsContract();
    assertCliGuideContracts();
    assertPlaceholderHygiene();
    assertPackageMainPointsToBuiltFile();
    printSummaryAndExit();
}

main();
