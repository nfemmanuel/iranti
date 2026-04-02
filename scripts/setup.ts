import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDb, initDb, disconnectDb } from '../src/library/client';
import { ensureEscalationFolders } from '../src/lib/escalationPaths';

function resolvePackageRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i += 1) {
        const pkgPath = path.join(dir, 'package.json');
        const prismaSchema = path.join(dir, 'prisma', 'schema.prisma');
        if (fs.existsSync(pkgPath) && fs.existsSync(prismaSchema)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`Could not resolve Iranti package root from ${__dirname}`);
}

const PACKAGE_ROOT = resolvePackageRoot();
const PRISMA_SCHEMA = path.join(PACKAGE_ROOT, 'prisma', 'schema.prisma');
const BASE_ENV = { ...process.env };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(command: string, label: string, extraEnv?: Record<string, string | undefined>): void {
    console.log(`  Running: ${label}...`);
    try {
        execSync(command, {
            stdio: 'inherit',
            cwd: PACKAGE_ROOT,
            env: {
                ...BASE_ENV,
                ...extraEnv,
            },
        });
    } catch {
        console.error(`  Failed: ${label}`);
        process.exit(1);
    }
}

function scriptCommand(distScriptName: string, sourceScriptPath: string): string {
    const distScriptPath = path.join(PACKAGE_ROOT, 'dist', 'scripts', distScriptName);
    if (fs.existsSync(distScriptPath)) {
        return `node ${JSON.stringify(distScriptPath)}`;
    }
    return `npx ts-node ${sourceScriptPath}`;
}

async function isSeeded(): Promise<boolean> {
    try {
        const entry = await getDb().knowledgeEntry.findUnique({
            where: {
                entityType_entityId_key: {
                    entityType: 'system',
                    entityId: 'library',
                    key: 'initialization_log',
                },
            },
        });
        return entry !== null;
    } catch {
        return false;
    }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setup() {
    console.log('\n🔧 Iranti Setup\n');
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
        process.env.DATABASE_URL = dbUrl;
        initDb(dbUrl, { applicationName: 'iranti:script:setup' });
    }
    const runtimeEnv = dbUrl
        ? {
            DATABASE_URL: dbUrl,
        }
        : undefined;

    // 1. Run migrations
    console.log('Step 1 — Running database migrations...');
    run(`npx prisma migrate deploy --schema ${JSON.stringify(PRISMA_SCHEMA)}`, 'prisma migrate deploy', runtimeEnv);
    console.log('  ✓ Migrations complete\n');

    // 2. Generate Prisma client
    console.log('Step 2 — Generating Prisma client...');
    run(`npx prisma generate --schema ${JSON.stringify(PRISMA_SCHEMA)}`, 'prisma generate', runtimeEnv);
    console.log('  ✓ Client generated\n');

    // 3. Seed Staff Namespace if not already seeded
    console.log('Step 3 — Seeding Staff Namespace...');
    const seeded = await isSeeded();
    if (seeded) {
        console.log('  ✓ Already seeded, skipping\n');
    } else {
        run(scriptCommand('seed.js', 'scripts/seed.ts'), 'seed Staff Namespace');
        console.log('  ✓ Staff Namespace seeded\n');
    }

    // 4. Pre-populate codebase knowledge
    console.log('Step 4 — Pre-populating codebase knowledge...');
    run(scriptCommand('seed-codebase.js', 'scripts/seed-codebase.ts'), 'seed codebase knowledge');
    console.log('  ✓ Codebase knowledge seeded\n');

    // 5. Ensure escalation folders exist
    console.log('Step 5 — Ensuring escalation folders...');
    const escalationPaths = await ensureEscalationFolders();
    console.log(`  ✓ Escalation folders ready at: ${escalationPaths.root}\n`);

    console.log('✅ Iranti setup complete.\n');
    console.log('Next steps:');
    console.log('  npm run test:integration   — verify everything works');
    console.log('  npm run dev                — start development\n');

    try {
        await disconnectDb();
    } catch {
        // Setup can complete without an initialized in-process DB client.
    }
    process.exit(0);
}

setup().catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
});
