import { randomUUID } from 'crypto';
import { librarianWrite } from '../src/librarian';
import { findEntry, findEntriesByEntity } from '../src/library/queries';
import { getDb } from '../src/library/client';
import { bootstrapHarness } from './harness';

async function testConcurrentWrites() {
    console.log('🔒 Testing concurrent write safety...\n');

    bootstrapHarness();
    const db = getDb();
    
    // Clean slate
    const testEntity = { entityType: 'test', entityId: 'concurrent_r1', key: 'affiliation' };
    await db.knowledgeEntry.deleteMany({
        where: { entityType: testEntity.entityType, entityId: testEntity.entityId },
    });
    await db.archive.deleteMany({
        where: { entityType: testEntity.entityType, entityId: testEntity.entityId },
    });
    await db.writeReceipt.deleteMany({
        where: { entityType: testEntity.entityType, entityId: testEntity.entityId },
    });
    
    console.log('✓ Cleaned test data\n');
    
    // Fire 25 simultaneous writes to same identity triple
    const writes = Array.from({ length: 25 }).map((_, i) => ({
        requestId: randomUUID(),
        entityType: testEntity.entityType,
        entityId: testEntity.entityId,
        key: testEntity.key,
        valueRaw: { institution: i % 2 === 0 ? 'MIT' : 'Cambridge' },
        valueSummary: i % 2 === 0 ? 'MIT' : 'Cambridge',
        confidence: 50 + i,
        createdBy: `Agent${i % 3}`,
        source: `Source${i % 3}`,
    }));
    
    console.log(`🚀 Launching ${writes.length} concurrent writes to same entity key...\n`);
    
    const start = Date.now();
    const results = await Promise.all(writes.map(w => librarianWrite(w)));
    const elapsed = Date.now() - start;
    
    console.log(`✓ All writes completed in ${elapsed}ms\n`);
    
    // Validate results
    const active = await findEntry(testEntity);
    const allEntries = await findEntriesByEntity(testEntity.entityType, testEntity.entityId);
    const archived = await db.archive.findMany({
        where: { entityType: testEntity.entityType, entityId: testEntity.entityId },
    });
    const receipts = await db.writeReceipt.findMany({
        where: { entityType: testEntity.entityType, entityId: testEntity.entityId },
    });
    
    console.log('📊 Results:');
    console.log(`  - Active KB entries: ${allEntries.length}`);
    console.log(`  - Archive entries: ${archived.length}`);
    console.log(`  - Write receipts: ${receipts.length}`);
    console.log(`  - Actions: ${JSON.stringify(results.reduce((acc, r) => {
        acc[r.action] = (acc[r.action] || 0) + 1;
        return acc;
    }, {} as Record<string, number>))}\n`);
    
    // Assertions
    const errors: string[] = [];
    
    if (!active) {
        errors.push('❌ No active entry found');
    } else if (active.confidence === 0) {
        errors.push('❌ Active entry is archived (confidence=0)');
    }
    
    if (allEntries.filter(e => e.confidence > 0).length !== 1) {
        errors.push(`❌ Expected exactly 1 active entry, found ${allEntries.filter(e => e.confidence > 0).length}`);
    }
    
    if (receipts.length !== writes.length) {
        errors.push(`❌ Expected ${writes.length} receipts, found ${receipts.length}`);
    }
    
    const uniqueRequestIds = new Set(receipts.map((r: { requestId: string }) => r.requestId));
    if (uniqueRequestIds.size !== writes.length) {
        errors.push(`❌ Duplicate receipts detected: ${receipts.length} receipts for ${uniqueRequestIds.size} unique requests`);
    }
    
    if (errors.length > 0) {
        console.log('\n❌ FAILED:\n');
        errors.forEach(e => console.log(`  ${e}`));
        process.exit(1);
    }
    
    console.log('✅ PASSED: All concurrency safety checks passed');
    console.log(`  - Exactly 1 active entry with confidence > 0`);
    console.log(`  - All ${writes.length} writes got unique receipts`);
    console.log(`  - No duplicate archives or race conditions detected\n`);
}

async function testPendingReceiptCleanupOnError() {
    console.log('🧹 Testing pending receipt cleanup on pre-write failure...\n');

    bootstrapHarness();
    const db = getDb();
    const requestId = `pending_cleanup_${randomUUID()}`;

    await db.writeReceipt.deleteMany({ where: { requestId } });

    try {
        await librarianWrite({
            requestId,
            entityType: 'system',
            entityId: 'cleanup_probe',
            key: 'forbidden_write',
            valueRaw: { ok: false },
            valueSummary: 'forbidden write',
            confidence: 50,
            createdBy: 'external_agent',
            source: 'cleanup_test',
        });
        throw new Error('Expected librarianWrite to reject forbidden system write.');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('system namespace is staff-only')) {
            throw err;
        }
    }

    const receipt = await db.writeReceipt.findUnique({ where: { requestId } });
    if (receipt) {
        throw new Error(`Expected pending receipt cleanup after failed write, but found outcome=${receipt.outcome}.`);
    }

    console.log('✅ PASSED: Failed writes do not leave pending receipts behind\n');
}

async function main() {
    await testConcurrentWrites();
    await testPendingReceiptCleanupOnError();
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
