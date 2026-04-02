import assert from 'assert';
import { createHealthCheckState, createVectorBackendMonitor, deriveOperatorStatus } from '../../src/api/healthChecks';

type FakeIntervalHandle = {
    delay: number;
    fn: () => void;
    cleared: boolean;
    unrefCalled: boolean;
    unref: () => void;
};

function testOperatorStatusUsesVectorHealth(): void {
    const runtimeMetadataHealth = createHealthCheckState({
        checked: true,
        ok: true,
        detail: 'runtime metadata written successfully',
    });
    const vectorBackendHealth = createHealthCheckState({
        checked: true,
        ok: false,
        detail: 'vector backend did not respond to ping',
    });

    const status = deriveOperatorStatus({
        runtimeAuthoritySource: 'instance',
        runtimeMetadataHealth,
        vectorBackendHealth,
    });

    assert.strictEqual(status, 'degraded', 'vector backend failures must degrade operator health');
}

async function testStartupProbeMarksHealthy(): Promise<void> {
    const monitor = createVectorBackendMonitor({
        ping: async () => true,
    });

    await monitor.probe('startup');

    assert.deepStrictEqual(monitor.state, {
        checked: true,
        ok: true,
        detail: 'vector backend responded to ping',
    });
}

async function testFalsePingMarksDegradedAndLogs(): Promise<void> {
    const logs: string[] = [];
    const monitor = createVectorBackendMonitor({
        ping: async () => false,
        logError: (message) => logs.push(message),
    });

    await monitor.probe('startup');

    assert.strictEqual(monitor.state.checked, true);
    assert.strictEqual(monitor.state.ok, false);
    assert.strictEqual(monitor.state.detail, 'vector backend did not respond to ping');
    assert.ok(
        logs.some((message) => message.includes('startup health check failed')),
        `expected startup failure log, received: ${logs.join('\n')}`,
    );
}

async function testIntervalProbeMarksThrownErrorsAndClearsTimer(): Promise<void> {
    const handles: FakeIntervalHandle[] = [];
    const logs: string[] = [];
    const monitor = createVectorBackendMonitor({
        ping: async () => {
            throw new Error('qdrant timeout');
        },
        logError: (message) => logs.push(message),
        setIntervalImpl: ((fn: () => void, delay?: number) => {
            const handle: FakeIntervalHandle = {
                delay: delay ?? 0,
                fn,
                cleared: false,
                unrefCalled: false,
                unref() {
                    this.unrefCalled = true;
                },
            };
            handles.push(handle);
            return handle as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearIntervalImpl: ((handle: ReturnType<typeof setInterval>) => {
            (handle as unknown as FakeIntervalHandle).cleared = true;
        }) as typeof clearInterval,
    });

    const intervalHandle = monitor.start() as unknown as FakeIntervalHandle;
    assert.strictEqual(handles.length, 1, 'monitor should schedule one recurring probe');
    assert.strictEqual(intervalHandle.delay, 60_000, 'monitor should use the post-start probe interval');
    assert.strictEqual(intervalHandle.unrefCalled, true, 'monitor interval should not keep the process alive');

    intervalHandle.fn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(monitor.state.checked, true);
    assert.strictEqual(monitor.state.ok, false);
    assert.strictEqual(monitor.state.detail, 'qdrant timeout');
    assert.ok(
        logs.some((message) => message.includes('interval health check error: qdrant timeout')),
        `expected interval error log, received: ${logs.join('\n')}`,
    );

    monitor.stop();
    assert.strictEqual(intervalHandle.cleared, true, 'monitor stop should clear the recurring probe timer');
}

async function main(): Promise<void> {
    testOperatorStatusUsesVectorHealth();
    await testStartupProbeMarksHealthy();
    await testFalsePingMarksDegradedAndLogs();
    await testIntervalProbeMarksThrownErrorsAndClearsTimer();
    console.log('vector health monitor tests passed');
}

void main();
