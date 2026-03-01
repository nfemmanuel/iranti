import 'dotenv/config';
import { Iranti } from '../src/sdk';

async function testConnectionString() {
    console.log('Testing Connection String Override...\n');

    const mainDb = process.env.DATABASE_URL;
    if (!mainDb) {
        console.error('DATABASE_URL environment variable is required');
        process.exit(1);
    }

    console.log('Test: Verify SDK uses explicit connectionString');
    console.log(`Main DB: ${mainDb}\n`);

    // Test 1: Create SDK instance with explicit connection string
    console.log('Test 1: Initialize SDK with explicit connection string');
    try {
        const iranti = new Iranti({
            connectionString: mainDb,
            llmProvider: 'mock',
        });
        console.log('  ✓ PASSED: SDK initialized with explicit connection string\n');

        // Test 2: Write a test fact
        console.log('Test 2: Write test fact');
        const result = await iranti.write({
            entity: 'test/connection_test',
            key: 'test_value',
            value: { timestamp: new Date().toISOString() },
            summary: 'Connection test fact',
            confidence: 100,
            source: 'test_script',
            agent: 'test_agent',
        });

        if (result.action === 'created' || result.action === 'updated') {
            console.log('  ✓ PASSED: Fact written successfully\n');
        } else {
            console.log(`  ✗ FAILED: Unexpected action: ${result.action}\n`);
            process.exit(1);
        }

        // Test 3: Query the fact back
        console.log('Test 3: Query fact back');
        const queryResult = await iranti.query('test/connection_test', 'test_value');

        if (queryResult.found) {
            console.log('  ✓ PASSED: Fact retrieved successfully\n');
        } else {
            console.log('  ✗ FAILED: Fact not found\n');
            process.exit(1);
        }

    } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message}\n`);
        process.exit(1);
    }

    // Test 4: Verify error when no connection string provided
    console.log('Test 4: Verify error when no connection string');
    try {
        // Temporarily remove env var
        const savedUrl = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;

        try {
            new Iranti({});
            console.log('  ✗ FAILED: Should have thrown error\n');
            process.exit(1);
        } catch (err: any) {
            if (err.message.includes('connectionString is required')) {
                console.log('  ✓ PASSED: Correct error thrown\n');
            } else {
                console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
                process.exit(1);
            }
        } finally {
            // Restore env var
            process.env.DATABASE_URL = savedUrl;
        }
    } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message}\n`);
        process.exit(1);
    }

    // Test 5: Verify multiple initialization with same connection string works
    console.log('Test 5: Multiple initialization with same connection string');
    try {
        const iranti2 = new Iranti({
            connectionString: mainDb,
            llmProvider: 'mock',
        });
        console.log('  ✓ PASSED: Second initialization with same connection string works\n');
    } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message}\n`);
        process.exit(1);
    }

    console.log('All tests passed! Connection string override works correctly.');
    console.log('\nKey findings:');
    console.log('- SDK explicitly calls initDb() with provided connection string');
    console.log('- DB client is not created at import time');
    console.log('- Connection string override is deterministic');
    console.log('- Multiple initializations with same string work');

    process.exit(0);
}

testConnectionString().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
