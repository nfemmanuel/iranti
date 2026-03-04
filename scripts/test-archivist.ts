import 'dotenv/config';
import { runArchivist } from '../src/archivist';
import { bootstrapHarness } from './harness';

async function test() {
    bootstrapHarness();
    console.log('Testing Archivist...\n');

    const report = await runArchivist();

    console.log('Archivist Report:');
    console.log('  Expired entries archived:', report.expiredArchived);
    console.log('  Low confidence archived:', report.lowConfidenceArchived);
    console.log('  Duplicates merged:', report.duplicatesMerged);
    console.log('  Escalations processed:', report.escalationsProcessed);

    if (report.errors.length > 0) {
        console.log('  Errors:');
        report.errors.forEach((e) => console.log('   -', e));
    } else {
        console.log('  Errors: none');
    }

    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
