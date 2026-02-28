import 'dotenv/config';
import { Iranti } from '../src/sdk';

async function seedCodebase() {
    console.log('Seeding codebase knowledge...');
    const iranti = new Iranti();

    const facts = [
        {
            key: 'npm_packages',
            value: {
                dependencies: {
                    '@anthropic-ai/sdk': '^0.78.0',
                    '@prisma/adapter-pg': '^7.4.2',
                    '@prisma/client': '^7.4.2',
                    'dotenv': '^17.3.1',
                    'pg': '^8.19.0',
                    'prisma': '^7.4.2',
                },
                devDependencies: {
                    '@types/pg': '^8.16.0',
                    'ts-node': '^10.9.2',
                    'typescript': '^5.0.0',
                },
                installCommand: 'npm install',
            },
            summary: 'NPM packages — prisma@7.4.2, pg@8.19.0, dotenv@17.3.1, typescript@5.0.0, @anthropic-ai/sdk@0.78.0',
        },
        {
            key: 'database',
            value: {
                engine: 'PostgreSQL',
                version: '16',
                name: 'iranti',
                user: 'postgres',
                host: 'localhost',
                port: 5432,
                notes: 'No password required in default local setup. Docker container: iranti_db.',
            },
            summary: 'PostgreSQL 16, database name iranti, user postgres, port 5432, Docker container iranti_db',
        },
        {
            key: 'tech_stack',
            value: {
                language: 'TypeScript',
                runtime: 'Node.js',
                orm: 'Prisma v7',
                prismaNotes: 'Requires @prisma/adapter-pg and PrismaPg adapter. Generator output: src/generated/prisma. Package versions: prisma@7.4.2, @prisma/adapter-pg@7.4.2, @prisma/client@7.4.2.',
                runner: 'ts-node for scripts, tsc for build',
                target: 'ES2020, commonjs modules',
            },
            summary: 'TypeScript, Node.js, Prisma v7 with PrismaPg adapter, ts-node runner',
        },
        {
            key: 'schema',
            value: {
                tables: ['knowledge_base', 'archive', 'entity_relationships'],
                uniqueConstraints: {
                    knowledge_base: ['entityType', 'entityId', 'key'],
                    entity_relationships: ['fromType', 'fromId', 'relationshipType', 'toType', 'toId'],
                },
                jsonColumns: ['valueRaw', 'conflictLog', 'properties'],
                protectedNamespace: 'entityType = system',
            },
            summary: '3 tables: knowledge_base, archive, entity_relationships. Unique on entityType/entityId/key.',
        },
        {
            key: 'llm_providers',
            value: {
                current: 'mock',
                available: ['mock', 'gemini', 'claude'],
                switchBy: 'LLM_PROVIDER env var',
                geminiModel: 'gemini-2.0-flash-001',
                conflictResolutionModel: 'gemini-2.5-pro',
                rateLimit: 'Free Gemini tier: 10 req/min on gemini-2.0-flash-001',
            },
            summary: 'LLM provider set via LLM_PROVIDER env var. Current: mock. Gemini and Claude implemented.',
        },
        {
            key: 'architecture_decisions',
            value: {
                license: 'AGPL — allows free self-hosting, protects hosted business',
                attendant: 'Per-agent class, singleton registry, persists state to KB',
                librarian: 'Shared instance, owns all DB writes',
                conflictThreshold: 'Gap >= 10 confidence points = deterministic resolution. Gap < 10 = LLM reasoning.',
                escalationFormat: 'Status must be exactly "**Status:** RESOLVED" for Archivist to process',
                entityFormat: 'entityType/entityId string in SDK e.g. researcher/jane_smith',
                propertiesColumn: 'Escape hatch for caller-defined metadata, no migrations needed',
            },
            summary: 'AGPL license, per-agent Attendants, shared Librarian, conflict threshold 10 points',
        },
        {
            key: 'open_questions',
            value: {
                hostedPricing: 'Consumption-based, reference Upstash model',
                archiveRetention: 'Indefinite vs rolling window — undecided',
                sdkLanguages: 'TypeScript first, Python SDK planned',
            },
            summary: 'Open: hosted pricing model, archive retention policy, Python SDK timeline',
        },
        {
            key: 'repo',
            value: {
                url: 'https://github.com/nfemmanuel/iranti',
                visibility: 'private — flip to public at open source launch',
                defaultBranch: 'main',
                commitFormat: '[component] description',
                branchFormat: 'feature/description or fix/description',
            },
            summary: 'GitHub repo nfemmanuel/iranti, private until open source launch',
        },
    ];

    for (const fact of facts) {
        const result = await iranti.write({
            entity: 'codebase/iranti',
            key: fact.key,
            value: fact.value,
            summary: fact.summary,
            confidence: 100,
            source: 'seed-codebase',
            agent: 'system',
        });
        console.log(`  [${fact.key}] ${result.action}`);
    }

    await iranti.registerAgent({
        agentId: 'system',
        name: 'System',
        description: 'Internal system agent for seeding and maintenance',
        capabilities: ['seeding', 'maintenance', 'setup'],
    });

    console.log('  ✓ Codebase knowledge seeded');
    process.exit(0);
}

seedCodebase().catch((err) => {
    console.error('Codebase seed failed:', err);
    process.exit(1);
});
