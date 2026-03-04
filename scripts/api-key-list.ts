import 'dotenv/config';
import { initDb, getDb } from '../src/library/client';
import { listApiKeys } from '../src/security/apiKeys';

async function main(): Promise<void> {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL is required.');
        process.exit(1);
    }

    initDb(dbUrl);
    const keys = await listApiKeys();

    if (keys.length === 0) {
        console.log('No registry API keys found.');
    } else {
        console.log(`Found ${keys.length} registry API key(s):\n`);
        for (const key of keys) {
            console.log(`- keyId: ${key.keyId}`);
            console.log(`  owner: ${key.owner}`);
            console.log(`  active: ${key.isActive}`);
            console.log(`  scopes: ${key.scopes.join(',') || '(none)'}`);
            console.log(`  createdAt: ${key.createdAt}`);
            if (key.revokedAt) {
                console.log(`  revokedAt: ${key.revokedAt}`);
            }
        }
    }

    await getDb().$disconnect();
}

main().catch(async (err) => {
    console.error('Failed to list API keys:', err instanceof Error ? err.message : String(err));
    try {
        await getDb().$disconnect();
    } catch {
        // ignore
    }
    process.exit(1);
});
