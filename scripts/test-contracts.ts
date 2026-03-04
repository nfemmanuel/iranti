import fs from 'fs';
import path from 'path';

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
        /app\.use\(ROUTES\.kb,\s*authenticate,\s*rateLimitMiddleware,\s*requireScopeByMethod\('kb:read',\s*'kb:write'\),\s*knowledgeRoutes\(iranti\)\);/,
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
        /app\.use\('\/kb',\s*authenticate,\s*rateLimitMiddleware,\s*requireAnyScope\(\['kb:read'\]\),\s*batchRouter\);/,
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
    expectIncludes(filePath, content, "router.post('/reconvene'", 'Memory route: POST /reconvene');
    expectIncludes(filePath, content, "router.post('/observe'", 'Memory route: POST /observe');
    expectIncludes(filePath, content, "router.post('/attend'", 'Memory route: POST /attend');
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

    expectIncludes(filePath, content, 'batchRouter.post("/batchQuery"', 'Batch route: POST /kb/batchQuery');
}

function assertPythonClientContract(): void {
    const filePath = 'clients/python/iranti.py';
    const content = readFile(filePath);

    expectIncludes(filePath, content, "'http://localhost:3001'", 'Python client default URL is localhost:3001');
    expectIncludes(filePath, content, "self._post('/kb/write'", 'Python client writes to /kb/write');
    expectIncludes(filePath, content, "self._post('/kb/ingest'", 'Python client ingests to /kb/ingest');
    expectIncludes(filePath, content, "self._get(f'/kb/query/{entity_type}/{entity_id}/{key}')", 'Python client queries /kb/query/:type/:id/:key');
    expectIncludes(filePath, content, "self._get(f'/kb/query/{entity_type}/{entity_id}')", 'Python client queries /kb/query/:type/:id');
    expectIncludes(filePath, content, "self._post('/kb/relate'", 'Python client relates via /kb/relate');
    expectIncludes(filePath, content, "self._get(f'/kb/related/{entity_type}/{entity_id}')", 'Python client reads /kb/related/:type/:id');
    expectIncludes(filePath, content, "self._get(f'/kb/related/{entity_type}/{entity_id}/deep?depth={depth}')", 'Python client reads /kb/related/:type/:id/deep');
    expectIncludes(filePath, content, "self._post('/memory/handshake'", 'Python client handshakes via /memory/handshake');
    expectIncludes(filePath, content, "self._post('/memory/reconvene'", 'Python client reconvenes via /memory/reconvene');
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
        'async attend(',
        'async query(',
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
        '- `POST /memory/attend`',
        '- `POST /memory/observe`',
        '- `GET /memory/whoknows/:entityType/:entityId`',
        '- `POST /agents/register`',
    ];

    for (const route of requiredRoutes) {
        expectIncludes(filePath, content, route, `API docs include ${route}`);
    }
}

function assertPackageMainPointsToBuiltFile(): void {
    const filePath = 'package.json';
    const packageJson = JSON.parse(readFile(filePath)) as { main?: string };
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
    assertApiDocsContract();
    assertPackageMainPointsToBuiltFile();
    printSummaryAndExit();
}

main();
