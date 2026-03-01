import 'dotenv/config';
import { librarianWrite } from '../src/librarian/index';

async function testStaffNamespaceProtection() {
    console.log('Testing Staff Namespace Protection...\n');

    // Test 1: Agent tries to write to system namespace
    console.log('Test 1: Agent writes to system namespace');
    try {
        await librarianWrite({
            entityType: 'system',
            entityId: 'librarian',
            key: 'operating_rules',
            valueRaw: { malicious: 'rule' },
            valueSummary: 'Poisoned rule',
            confidence: 100,
            source: 'AgentX',
            createdBy: 'AgentX',
        });
        console.log('  ✗ FAILED: Write should have been blocked\n');
        process.exit(1);
    } catch (err: any) {
        if (err.message.includes('system namespace is staff-only')) {
            console.log('  ✓ PASSED: Write blocked correctly\n');
        } else {
            console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
            process.exit(1);
        }
    }

    // Test 2: Agent tries to write reserved key
    console.log('Test 2: Agent writes attendant_state');
    try {
        await librarianWrite({
            entityType: 'agent',
            entityId: 'test_agent',
            key: 'attendant_state',
            valueRaw: { poisoned: 'state' },
            valueSummary: 'Poisoned state',
            confidence: 100,
            source: 'AgentX',
            createdBy: 'AgentX',
        });
        console.log('  ✗ FAILED: Write should have been blocked\n');
        process.exit(1);
    } catch (err: any) {
        if (err.message.includes("key 'attendant_state' is reserved")) {
            console.log('  ✓ PASSED: Write blocked correctly\n');
        } else {
            console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
            process.exit(1);
        }
    }

    // Test 3: Attendant writes attendant_state (should succeed)
    console.log('Test 3: Attendant writes attendant_state');
    try {
        const result = await librarianWrite({
            entityType: 'agent',
            entityId: 'test_agent',
            key: 'attendant_state',
            valueRaw: { valid: 'state' },
            valueSummary: 'Valid state',
            confidence: 100,
            source: 'Attendant',
            createdBy: 'Attendant',
        });
        if (result.action === 'created' || result.action === 'updated') {
            console.log('  ✓ PASSED: Attendant write succeeded\n');
        } else {
            console.log(`  ✗ FAILED: Write rejected: ${result.reason}\n`);
            process.exit(1);
        }
    } catch (err: any) {
        console.log(`  ✗ FAILED: Unexpected error: ${err.message}\n`);
        process.exit(1);
    }

    // Test 4: Seed writes to system namespace (should succeed)
    console.log('Test 4: Seed writes to system namespace');
    try {
        const result = await librarianWrite({
            entityType: 'system',
            entityId: 'test',
            key: 'test_key',
            valueRaw: { valid: 'data' },
            valueSummary: 'Valid system entry',
            confidence: 100,
            source: 'Seed',
            createdBy: 'Seed',
        });
        if (result.action === 'created' || result.action === 'updated') {
            console.log('  ✓ PASSED: Seed write succeeded\n');
        } else {
            console.log(`  ✗ FAILED: Write rejected: ${result.reason}\n`);
            process.exit(1);
        }
    } catch (err: any) {
        console.log(`  ✗ FAILED: Unexpected error: ${err.message}\n`);
        process.exit(1);
    }

    console.log('All tests passed! Staff namespace is protected.');
    process.exit(0);
}

testStaffNamespaceProtection().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
