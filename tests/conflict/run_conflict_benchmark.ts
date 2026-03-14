import 'dotenv/config';
import { prepareConflictBenchmark, runSuite, CaseResult } from './common';
import { directContradictionSuite } from './direct-contradiction';
import { temporalConflictSuite } from './temporal-conflict';
import { cascadingConflictSuite } from './cascading-conflict';
import { multiHopConflictSuite } from './multi-hop-conflict';

async function main() {
    const iranti = await prepareConflictBenchmark();
    const suites = [
        directContradictionSuite,
        temporalConflictSuite,
        cascadingConflictSuite,
        multiHopConflictSuite,
    ];

    const allResults: CaseResult[] = [];
    for (const suite of suites) {
        const results = await runSuite(suite, iranti);
        allResults.push(...results);
    }

    printSummary(allResults);

    const failed = allResults.filter((result) => result.status === 'fail').length;
    process.exit(failed === 0 ? 0 : 1);
}

function printSummary(results: CaseResult[]): void {
    const grouped = new Map<string, CaseResult[]>();
    for (const result of results) {
        const current = grouped.get(result.suite) ?? [];
        current.push(result);
        grouped.set(result.suite, current);
    }

    console.log('Conflict resolution benchmark');
    console.log('------------------------------');

    let totalPassed = 0;
    let totalCases = 0;

    for (const [suite, cases] of grouped) {
        const passed = cases.filter((item) => item.status === 'pass' || item.status === 'xpass').length;
        const xfails = cases.filter((item) => item.status === 'xfail').length;
        totalPassed += passed;
        totalCases += cases.length;

        let suffix = '';
        if (xfails > 0) {
            suffix = `  (${xfails} known-failing)`;
        }
        console.log(`${suite.padEnd(24)} ${String(passed).padStart(2)}/${cases.length}${suffix}`);

        for (const item of cases) {
            const marker = statusLabel(item.status);
            const details = item.details ? ` — ${item.details}` : '';
            console.log(`  ${marker} ${item.name}${details}`);
        }
    }

    console.log('------------------------------');
    console.log(`Total: ${totalPassed}/${totalCases} (${Math.round((totalPassed / totalCases) * 100)}%)`);
}

function statusLabel(status: CaseResult['status']): string {
    switch (status) {
        case 'pass':
            return 'PASS ';
        case 'fail':
            return 'FAIL ';
        case 'xfail':
            return 'XFAIL';
        case 'xpass':
            return 'XPASS';
    }
}

main().catch((err) => {
    console.error('Conflict benchmark failed:', err);
    process.exit(1);
});
