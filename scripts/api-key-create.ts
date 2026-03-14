import 'dotenv/config';
import { initDb } from '../src/library/client';
import { createOrRotateApiKey } from '../src/security/apiKeys';

function parseArg(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx === -1) return undefined;
    return process.argv[idx + 1];
}

async function main(): Promise<void> {
    const keyId = parseArg('--key-id') ?? parseArg('-k');
    const owner = parseArg('--owner') ?? parseArg('-o');
    const scopesRaw = parseArg('--scopes') ?? '';
    const description = parseArg('--description');
    const scopes = scopesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    if (!keyId || !owner) {
        console.error('Usage: npm run api-key:create -- --key-id <id> --owner <owner> [--scopes read,write] [--description "text"]');
        process.exit(1);
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL is required.');
        process.exit(1);
    }

    initDb(dbUrl);

    const created = await createOrRotateApiKey({
        keyId,
        owner,
        scopes,
        description,
    });

    console.log('\nAPI key created (or rotated):');
    console.log(`  keyId: ${created.record.keyId}`);
    console.log(`  owner: ${created.record.owner}`);
    console.log(`  scopes: ${created.record.scopes.join(',') || '(none)'}`);
    console.log(`  active: ${created.record.isActive}`);
    console.log('\nCopy this token now (it will not be shown again):');
    console.log(created.token);
    console.log('\nUse it as: X-Iranti-Key: <token>\n');

    process.exit(0);
}

main().catch(async (err) => {
    console.error('Failed to create API key:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
