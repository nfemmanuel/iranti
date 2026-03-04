import 'dotenv/config';

async function auditRoutes() {
    console.log('Auditing Route Protection...\n');

    const baseUrl = `http://localhost:${process.env.IRANTI_PORT ?? '3001'}`;
    const tests = [
        { method: 'GET', path: '/health', expectAuth: false },
        { method: 'POST', path: '/agents/register', expectAuth: true },
        { method: 'GET', path: '/agents', expectAuth: true },
        { method: 'POST', path: '/kb/write', expectAuth: true },
        { method: 'POST', path: '/kb/ingest', expectAuth: true },
        { method: 'GET', path: '/kb/query/test/test/test', expectAuth: true },
        { method: 'POST', path: '/kb/relate', expectAuth: true },
        { method: 'POST', path: '/memory/handshake', expectAuth: true },
        { method: 'POST', path: '/memory/reconvene', expectAuth: true },
        { method: 'POST', path: '/memory/observe', expectAuth: true },
        { method: 'POST', path: '/memory/attend', expectAuth: true },
        { method: 'POST', path: '/memory/maintenance', expectAuth: true },
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        const url = `${baseUrl}${test.path}`;
        
        try {
            const response = await fetch(url, {
                method: test.method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: test.method === 'POST' ? JSON.stringify({}) : undefined,
            });

            const status = response.status;

            if (test.expectAuth) {
                // Should get 401 without auth
                if (status === 401) {
                    console.log(`✓ ${test.method} ${test.path} - Protected (401)`);
                    passed++;
                } else {
                    console.log(`✗ ${test.method} ${test.path} - NOT PROTECTED (got ${status}, expected 401)`);
                    failed++;
                }
            } else {
                // Should get 200 or other non-401
                if (status !== 401) {
                    console.log(`✓ ${test.method} ${test.path} - Public (${status})`);
                    passed++;
                } else {
                    console.log(`✗ ${test.method} ${test.path} - INCORRECTLY PROTECTED (got 401)`);
                    failed++;
                }
            }
        } catch (err: any) {
            console.log(`✗ ${test.method} ${test.path} - ERROR: ${err.message}`);
            failed++;
        }
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        console.log('\n⚠ Some routes are not properly protected!');
        process.exit(1);
    } else {
        console.log('\n✓ All routes properly protected!');
        process.exit(0);
    }
}

console.log('Make sure the API server is running on port', process.env.IRANTI_PORT ?? '3001');
console.log('Starting audit in 2 seconds...\n');

setTimeout(() => {
    auditRoutes().catch((err) => {
        console.error('Audit failed:', err);
        process.exit(1);
    });
}, 2000);
