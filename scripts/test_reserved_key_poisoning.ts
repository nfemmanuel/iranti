import 'dotenv/config';
import { librarianWrite } from '../src/librarian/index';
import { bootstrapHarness, errorMatches } from './harness';

bootstrapHarness();

async function testReservedKeyPoisoning() {
    console.log('Testing Reserved Key Poisoning Protection...\n');

    // Test 1: Agent tries to write attendant_state (reserved key)
    console.log('Test 1: Agent writes attendant_state (reserved key)');
    try {
        await librarianWrite({
            entityType: 'agent',
            entityId: 'agentA',
            key: 'attendant_state',
            valueRaw: { poisoned: 'state' },
            valueSummary: 'Poisoned attendant state',
            confidence: 100,
            source: 'agentA',
            createdBy: 'agentA',
        });
        console.log('  ✗ FAILED: Write should have been blocked\n');
        process.exit(1);
    } catch (err: any) {
        if (errorMatches(err, [
            /key 'attendant_state' is reserved/i,
            /attendant_state is reserved for staff/i,
        ])) {
            console.log('  ✓ PASSED: Reserved key write blocked\n');
        } else {
            console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
            process.exit(1);
        }
    }

    // Test 2: Attendant writes attendant_state (should succeed)
    console.log('Test 2: Attendant writes attendant_state');
    try {
        const result = await librarianWrite({
            entityType: 'agent',
            entityId: 'agentA',
            key: 'attendant_state',
            valueRaw: { valid: 'state' },
            valueSummary: 'Valid attendant state',
            confidence: 100,
            source: 'Attendant',
            createdBy: 'Attendant',
        });
        if (result.action === 'created' || result.action === 'updated') {
            console.log('  ✓ PASSED: Attendant write succeeded\n');
        } else {
            console.log(`  ✗ FAILED: Unexpected action: ${result.action}\n`);
            process.exit(1);
        }
    } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message}\n`);
        process.exit(1);
    }

    // Test 3: AgentA tries to write to AgentB's namespace (cross-agent)
    console.log('Test 3: AgentA writes to AgentB namespace');
    try {
        await librarianWrite({
            entityType: 'agent',
            entityId: 'agentB',
            key: 'notes',
            valueRaw: { poisoned: 'notes' },
            valueSummary: 'Poisoned notes',
            confidence: 100,
            source: 'agentA',
            createdBy: 'agentA',
        });
        console.log('  ✗ FAILED: Cross-agent write should have been blocked\n');
        process.exit(1);
    } catch (err: any) {
        if (err.message.includes('agents may only write to their own agent namespace')) {
            console.log('  ✓ PASSED: Cross-agent write blocked\n');
        } else {
            console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
            process.exit(1);
        }
    }

    // Test 4: AgentA writes to its own namespace (should succeed)
    console.log('Test 4: AgentA writes to its own namespace');
    try {
        const result = await librarianWrite({
            entityType: 'agent',
            entityId: 'agentA',
            key: 'notes',
            valueRaw: { valid: 'notes' },
            valueSummary: 'Valid notes',
            confidence: 100,
            source: 'agentA',
            createdBy: 'agentA',
        });
        if (result.action === 'created' || result.action === 'updated') {
            console.log('  ✓ PASSED: Self-write succeeded\n');
        } else {
            console.log(`  ✗ FAILED: Unexpected action: ${result.action}\n`);
            process.exit(1);
        }
    } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message}\n`);
        process.exit(1);
    }

    // Test 5: Agent tries to write underscore-prefixed key
    console.log('Test 5: Agent writes underscore-prefixed key');
    try {
        await librarianWrite({
            entityType: 'researcher',
            entityId: 'test',
            key: '_internal_state',
            valueRaw: { poisoned: 'internal' },
            valueSummary: 'Poisoned internal state',
            confidence: 100,
            source: 'agentA',
            createdBy: 'agentA',
        });
        console.log('  ✗ FAILED: Underscore-prefixed key write should have been blocked\n');
        process.exit(1);
    } catch (err: any) {
        if (err.message.includes('underscore-prefixed keys are reserved')) {
            console.log('  ✓ PASSED: Underscore-prefixed key write blocked\n');
        } else {
            console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
            process.exit(1);
        }
    }

    // Test 6: Staff writes underscore-prefixed key (should succeed)
    console.log('Test 6: Staff writes underscore-prefixed key');
    try {
        const result = await librarianWrite({
            entityType: 'researcher',
            entityId: 'test',
            key: '_internal_state',
            valueRaw: { valid: 'internal' },
            valueSummary: 'Valid internal state',
            confidence: 100,
            source: 'Librarian',
            createdBy: 'Librarian',
        });
        if (result.action === 'created' || result.action === 'updated') {
            console.log('  ✓ PASSED: Staff write of underscore-prefixed key succeeded\n');
        } else {
            console.log(`  ✗ FAILED: Unexpected action: ${result.action}\n`);
            process.exit(1);
        }
    } catch (err: any) {
        console.log(`  ✗ FAILED: ${err.message}\n`);
        process.exit(1);
    }

    // Test 7: Agent tries to write agent_profile (reserved key)
    console.log('Test 7: Agent writes agent_profile (reserved key)');
    try {
        await librarianWrite({
            entityType: 'agent',
            entityId: 'agentA',
            key: 'agent_profile',
            valueRaw: { poisoned: 'profile' },
            valueSummary: 'Poisoned profile',
            confidence: 100,
            source: 'agentA',
            createdBy: 'agentA',
        });
        console.log('  ✗ FAILED: Write should have been blocked\n');
        process.exit(1);
    } catch (err: any) {
        if (errorMatches(err, [/key 'agent_profile' is reserved/i])) {
            console.log('  ✓ PASSED: Reserved key write blocked\n');
        } else {
            console.log(`  ✗ FAILED: Wrong error: ${err.message}\n`);
            process.exit(1);
        }
    }

    console.log('All tests passed! Reserved key poisoning is impossible.');
    console.log('\nProtections verified:');
    console.log('- Reserved keys (attendant_state, agent_profile) protected');
    console.log('- Cross-agent namespace writes blocked');
    console.log('- Underscore-prefixed keys protected');
    console.log('- Staff writers can still write reserved keys');
    console.log('- Agents can write to their own namespace');

    process.exit(0);
}

testReservedKeyPoisoning().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
