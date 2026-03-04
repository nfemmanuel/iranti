import 'dotenv/config';
import { librarianWrite } from '../src/librarian/index';
import { randomUUID } from 'crypto';
import { bootstrapHarness } from './harness';

bootstrapHarness();

async function testIdempotency() {
    console.log('Testing Idempotency...\n');

    const requestId = randomUUID();
    const testEntity = {
        entityType: 'test',
        entityId: 'idempotency_test',
        key: 'test_value',
    };

    // Test 1: First write with requestId
    console.log('Test 1: First write with requestId');
    const result1 = await librarianWrite({
        ...testEntity,
        valueRaw: { data: 'test', timestamp: new Date().toISOString() },
        valueSummary: 'Test value',
        confidence: 80,
        source: 'test_source',
        createdBy: 'test_agent',
        requestId,
    });

    if (result1.action === 'created' || result1.action === 'updated') {
        console.log(`  ✓ PASSED: First write succeeded (${result1.action})\n`);
    } else {
        console.log(`  ✗ FAILED: Unexpected action: ${result1.action}\n`);
        process.exit(1);
    }

    // Test 2: Retry with same requestId (should be idempotent)
    console.log('Test 2: Retry with same requestId');
    const result2 = await librarianWrite({
        ...testEntity,
        valueRaw: { data: 'different_data', timestamp: new Date().toISOString() },
        valueSummary: 'Different value',
        confidence: 90,
        source: 'different_source',
        createdBy: 'test_agent',
        requestId, // Same requestId
    });

    if (result2.idempotentReplay) {
        console.log('  ✓ PASSED: Idempotent replay detected\n');
    } else {
        console.log('  ✗ FAILED: Should have been idempotent replay\n');
        process.exit(1);
    }

    if (result2.action === result1.action) {
        console.log('  ✓ PASSED: Same outcome returned\n');
    } else {
        console.log(`  ✗ FAILED: Different outcome (first: ${result1.action}, second: ${result2.action})\n`);
        process.exit(1);
    }

    // Test 3: Third retry (should still be idempotent)
    console.log('Test 3: Third retry with same requestId');
    const result3 = await librarianWrite({
        ...testEntity,
        valueRaw: { data: 'yet_another_value' },
        valueSummary: 'Yet another value',
        confidence: 95,
        source: 'yet_another_source',
        createdBy: 'test_agent',
        requestId, // Same requestId
    });

    if (result3.idempotentReplay) {
        console.log('  ✓ PASSED: Still idempotent on third retry\n');
    } else {
        console.log('  ✗ FAILED: Should still be idempotent\n');
        process.exit(1);
    }

    // Test 4: Different requestId should create new write
    console.log('Test 4: Different requestId creates new write');
    const newRequestId = randomUUID();
    const result4 = await librarianWrite({
        entityType: 'test',
        entityId: 'idempotency_test_2',
        key: 'test_value',
        valueRaw: { data: 'new_test' },
        valueSummary: 'New test value',
        confidence: 85,
        source: 'test_source',
        createdBy: 'test_agent',
        requestId: newRequestId,
    });

    if (!result4.idempotentReplay && (result4.action === 'created' || result4.action === 'updated')) {
        console.log('  ✓ PASSED: New requestId creates new write\n');
    } else {
        console.log('  ✗ FAILED: Should have created new write\n');
        process.exit(1);
    }

    // Test 5: No requestId still works (backward compatibility)
    console.log('Test 5: Write without requestId (backward compatibility)');
    const result5 = await librarianWrite({
        entityType: 'test',
        entityId: 'idempotency_test_3',
        key: 'test_value',
        valueRaw: { data: 'no_request_id' },
        valueSummary: 'No request ID',
        confidence: 75,
        source: 'test_source',
        createdBy: 'test_agent',
        // No requestId
    });

    if (result5.action === 'created' || result5.action === 'updated') {
        console.log('  ✓ PASSED: Write without requestId still works\n');
    } else {
        console.log('  ✗ FAILED: Should have succeeded\n');
        process.exit(1);
    }

    console.log('All tests passed! Idempotency working correctly.');
    console.log('\nKey findings:');
    console.log('- Same requestId returns same outcome (no duplicate side effects)');
    console.log('- Idempotent replay flag set correctly');
    console.log('- Different requestId creates new write');
    console.log('- Backward compatible (requestId optional)');

    process.exit(0);
}

testIdempotency().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
