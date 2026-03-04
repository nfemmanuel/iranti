import { randomUUID } from 'crypto';
import { librarianWrite } from '../src/librarian';
import { bootstrapHarness } from './harness';

async function testStaffNormalization() {
    console.log('🔒 Testing staff identity normalization...\n');

    bootstrapHarness();
    
    // Test 1: Mixed-case staff writer should succeed
    console.log('Test 1: Mixed-case staff writer (Archivist)');
    try {
        const result = await librarianWrite({
            requestId: randomUUID(),
            entityType: 'system',
            entityId: 'test',
            key: 'test_value',
            valueRaw: { test: true },
            valueSummary: 'Test value',
            confidence: 100,
            source: 'test',
            createdBy: 'Archivist', // Mixed case
        });
        console.log(`  ✓ Success: ${result.action}`);
    } catch (err) {
        console.log(`  ❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    
    // Test 2: Lowercase staff writer should succeed
    console.log('\nTest 2: Lowercase staff writer (librarian)');
    try {
        const result = await librarianWrite({
            requestId: randomUUID(),
            entityType: 'system',
            entityId: 'test',
            key: 'test_value2',
            valueRaw: { test: true },
            valueSummary: 'Test value 2',
            confidence: 100,
            source: 'test',
            createdBy: 'librarian', // Lowercase
        });
        console.log(`  ✓ Success: ${result.action}`);
    } catch (err) {
        console.log(`  ❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    
    // Test 3: Non-staff writer should fail
    console.log('\nTest 3: Non-staff writer (AgentA)');
    try {
        const result = await librarianWrite({
            requestId: randomUUID(),
            entityType: 'system',
            entityId: 'test',
            key: 'test_value3',
            valueRaw: { test: true },
            valueSummary: 'Test value 3',
            confidence: 100,
            source: 'test',
            createdBy: 'AgentA', // Not staff
        });
        console.log(`  ❌ Should have failed but got: ${result.action}`);
        process.exit(1);
    } catch (err) {
        console.log(`  ✓ Correctly blocked: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Test 4: Uppercase staff writer should succeed
    console.log('\nTest 4: Uppercase staff writer (ATTENDANT)');
    try {
        const result = await librarianWrite({
            requestId: randomUUID(),
            entityType: 'system',
            entityId: 'test',
            key: 'test_value4',
            valueRaw: { test: true },
            valueSummary: 'Test value 4',
            confidence: 100,
            source: 'test',
            createdBy: 'ATTENDANT', // Uppercase
        });
        console.log(`  ✓ Success: ${result.action}`);
    } catch (err) {
        console.log(`  ❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    
    console.log('\n✅ All staff normalization tests passed');
}

testStaffNormalization().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
