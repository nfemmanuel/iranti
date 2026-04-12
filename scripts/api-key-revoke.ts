/**
 * CLI utility to revoke an iranti API key by keyId.
 *
 * Args: --key-id <id> (alias: -k). Exits non-zero if the key is not found.
 * Run: `npm run api-key:revoke -- --key-id <id>`. Requires DATABASE_URL.
 */
import 'dotenv/config';
import { initDb } from '../src/library/client';
import { revokeApiKey } from '../src/security/apiKeys';

function parseArg(flag: string): string | undefined {
    const idx = process.argv.indexOf(flag);
    if (idx === -1) return undefined;
    return process.argv[idx + 1];
}

async function main(): Promise<void> {
    const keyId = parseArg('--key-id') ?? parseArg('-k');
    if (!keyId) {
        console.error('Usage: npm run api-key:revoke -- --key-id <id>');
        process.exit(1);
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL is required.');
        process.exit(1);
    }

    initDb(dbUrl, { applicationName: 'iranti:script:api_key_revoke' });
    const revoked = await revokeApiKey(keyId);
    if (!revoked) {
        console.error(`API key not found: ${keyId}`);
        process.exit(1);
    }

    console.log(`Revoked API key: ${keyId}`);
    process.exit(0);
}

main().catch(async (err) => {
    console.error('Failed to revoke API key:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
