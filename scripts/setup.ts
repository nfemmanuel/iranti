import { execSync } from 'child_process';
import { prisma } from '../src/library/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(command: string, label: string): void {
    console.log(`  Running: ${label}...`);
    try {
        execSync(command, { stdio: 'inherit' });
    } catch {
        console.error(`  Failed: ${label}`);
        process.exit(1);
    }
}

async function isSeeded(): Promise<boolean> {
    try {
        const entry = await prisma.knowledgeEntry.findUnique({
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

    // 1. Run migrations
    console.log('Step 1 — Running database migrations...');
    run('npx prisma migrate deploy', 'prisma migrate deploy');
    console.log('  ✓ Migrations complete\n');

    // 2. Generate Prisma client
    console.log('Step 2 — Generating Prisma client...');
    run('npx prisma generate', 'prisma generate');
    console.log('  ✓ Client generated\n');

    // 3. Seed Staff Namespace if not already seeded
    console.log('Step 3 — Seeding Staff Namespace...');
    const seeded = await isSeeded();
    if (seeded) {
        console.log('  ✓ Already seeded, skipping\n');
    } else {
        run('npx ts-node scripts/seed.ts', 'seed Staff Namespace');
        console.log('  ✓ Staff Namespace seeded\n');
    }

    // 4. Pre-populate codebase knowledge
    console.log('Step 4 — Pre-populating codebase knowledge...');
    run('npx ts-node scripts/seed-codebase.ts', 'seed codebase knowledge');
    console.log('  ✓ Codebase knowledge seeded\n');

    console.log('✅ Iranti setup complete.\n');
    console.log('Next steps:');
    console.log('  npm run test:integration   — verify everything works');
    console.log('  npm run dev                — start development\n');

    await prisma.$disconnect();
    process.exit(0);
}

setup().catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
});
