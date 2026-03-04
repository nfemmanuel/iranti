import 'dotenv/config';
import { librarianWrite } from '../src/librarian/index';
import { getDb } from '../src/library/client';
import { bootstrapHarness } from './harness';

async function testArchiveTraceability() {
    bootstrapHarness();
    console.log('Testing Archive Traceability...\n');

    const testEntity = {
        entityType: 'test',
        entityId: 'traceability_test',
        key: 'value',
    };

    // Clean up any existing test data
    await getDb().knowledgeEntry.deleteMany({
        where: testEntity,
    });
    await getDb().archive.deleteMany({
        where: testEntity,
    });

    // Test 1: Write initial entry
    console.log('Test 1: Write initial entry');
    const result1 = await librarianWrite({
        ...testEntity,
        valueRaw: { version: 1, data: 'original' },
        valueSummary: 'Original value',
        confidence: 70,
        source: 'source_a',
        createdBy: 'test_agent',
    });

    if (result1.action !== 'created') {
        console.log(`  ✗ FAILED: Expected created, got ${result1.action}\n`);
        process.exit(1);
    }
    console.log('  ✓ PASSED: Initial entry created\n');

    // Test 2: Write higher-confidence replacement
    console.log('Test 2: Write replacement with higher confidence');
    const result2 = await librarianWrite({
        ...testEntity,
        valueRaw: { version: 2, data: 'updated' },
        valueSummary: 'Updated value',
        confidence: 90,
        source: 'source_b',
        createdBy: 'test_agent',
    });

    if (result2.action !== 'updated') {
        console.log(`  ✗ FAILED: Expected updated, got ${result2.action}\n`);
        process.exit(1);
    }
    console.log('  ✓ PASSED: Replacement entry created\n');

    // Test 3: Verify archive entry exists
    console.log('Test 3: Verify archive entry');
    const archiveEntries = await getDb().archive.findMany({
        where: testEntity,
    });

    if (archiveEntries.length !== 1) {
        console.log(`  ✗ FAILED: Expected 1 archive entry, found ${archiveEntries.length}\n`);
        process.exit(1);
    }
    console.log('  ✓ PASSED: Archive entry exists\n');

    // Test 4: Verify archive has supersededBy pointer
    console.log('Test 4: Verify supersededBy pointer');
    const archived = archiveEntries[0];
    
    if (!archived.supersededByEntityType || !archived.supersededByEntityId || !archived.supersededByKey) {
        console.log('  ✗ FAILED: supersededBy pointer fields are null\n');
        console.log(`    supersededByEntityType: ${archived.supersededByEntityType}`);
        console.log(`    supersededByEntityId: ${archived.supersededByEntityId}`);
        console.log(`    supersededByKey: ${archived.supersededByKey}\n`);
        process.exit(1);
    }

    if (
        archived.supersededByEntityType !== testEntity.entityType ||
        archived.supersededByEntityId !== testEntity.entityId ||
        archived.supersededByKey !== testEntity.key
    ) {
        console.log('  ✗ FAILED: supersededBy pointer does not match replacement identity\n');
        process.exit(1);
    }
    console.log('  ✓ PASSED: supersededBy pointer correctly set\n');

    // Test 5: Verify archive preserves old value
    console.log('Test 5: Verify archive preserves old value');
    const oldValue = archived.valueRaw as any;
    
    if (oldValue.version !== 1 || oldValue.data !== 'original') {
        console.log('  ✗ FAILED: Archive does not preserve original value\n');
        console.log(`    Expected: { version: 1, data: 'original' }`);
        console.log(`    Got: ${JSON.stringify(oldValue)}\n`);
        process.exit(1);
    }

    if (archived.valueSummary !== 'Original value') {
        console.log('  ✗ FAILED: Archive does not preserve original summary\n');
        process.exit(1);
    }

    if (archived.confidence !== 70) {
        console.log('  ✗ FAILED: Archive does not preserve original confidence\n');
        process.exit(1);
    }

    if (archived.source !== 'source_a') {
        console.log('  ✗ FAILED: Archive does not preserve original source\n');
        process.exit(1);
    }

    console.log('  ✓ PASSED: Archive preserves old value and metadata\n');

    // Test 6: Verify KB has new value
    console.log('Test 6: Verify KB has new value');
    const currentEntry = await getDb().knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: testEntity,
        },
    });

    if (!currentEntry) {
        console.log('  ✗ FAILED: Current entry not found in KB\n');
        process.exit(1);
    }

    const newValue = currentEntry.valueRaw as any;
    if (newValue.version !== 2 || newValue.data !== 'updated') {
        console.log('  ✗ FAILED: KB does not have new value\n');
        process.exit(1);
    }

    if (currentEntry.confidence !== 90) {
        console.log('  ✗ FAILED: KB does not have new confidence\n');
        process.exit(1);
    }

    console.log('  ✓ PASSED: KB has new value\n');

    // Test 7: Verify conflictLog preserved
    console.log('Test 7: Verify conflictLog preserved in archive');
    const conflictLog = archived.conflictLog as any[];
    
    if (!Array.isArray(conflictLog)) {
        console.log('  ✗ FAILED: conflictLog is not an array\n');
        process.exit(1);
    }

    console.log('  ✓ PASSED: conflictLog preserved\n');

    // Cleanup
    await getDb().knowledgeEntry.deleteMany({ where: testEntity });
    await getDb().archive.deleteMany({ where: testEntity });

    console.log('All tests passed! Archive traceability is working correctly.');
    process.exit(0);
}

testArchiveTraceability().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
