export type HealthCheckState = {
    checked: boolean;
    ok: boolean;
    detail: string;
};

export type OperatorStatusContext = {
    runtimeAuthoritySource: 'env' | 'instance' | 'workspace' | 'invalid' | string;
    runtimeMetadataHealth: HealthCheckState;
    vectorBackendHealth: HealthCheckState;
};

export type ProbeContext = 'startup' | 'interval';

type IntervalHandle = ReturnType<typeof setInterval>;

type VectorBackendMonitorOptions = {
    ping: () => Promise<boolean>;
    intervalMs?: number;
    logError?: (message: string) => void;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
};

export function createHealthCheckState(initial: HealthCheckState): HealthCheckState {
    return { ...initial };
}

export function deriveOperatorStatus(context: OperatorStatusContext): 'ok' | 'degraded' {
    if (context.runtimeAuthoritySource === 'invalid') return 'degraded';
    if (context.runtimeMetadataHealth.checked && !context.runtimeMetadataHealth.ok) return 'degraded';
    if (context.vectorBackendHealth.checked && !context.vectorBackendHealth.ok) return 'degraded';
    return 'ok';
}

export function createVectorBackendMonitor(options: VectorBackendMonitorOptions) {
    const state = createHealthCheckState({
        checked: false,
        ok: true,
        detail: 'vector backend has not been probed yet',
    });
    const intervalMs = options.intervalMs ?? 60_000;
    const setIntervalImpl = options.setIntervalImpl ?? setInterval;
    const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
    const logError = options.logError ?? (() => undefined);
    let intervalHandle: IntervalHandle | null = null;

    function mark(ok: boolean, detail: string): void {
        state.checked = true;
        state.ok = ok;
        state.detail = detail;
    }

    async function probe(context: ProbeContext): Promise<void> {
        try {
            const ok = await options.ping();
            if (!ok) {
                mark(false, 'vector backend did not respond to ping');
                logError(`[vector] ${context} health check failed: vector backend is not responding.`);
                return;
            }
            mark(true, 'vector backend responded to ping');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            mark(false, message);
            logError(`[vector] ${context} health check error: ${message}`);
        }
    }

    function start(): IntervalHandle {
        if (intervalHandle) return intervalHandle;
        intervalHandle = setIntervalImpl(() => {
            void probe('interval');
        }, intervalMs);
        intervalHandle.unref?.();
        return intervalHandle;
    }

    function stop(): void {
        if (!intervalHandle) return;
        clearIntervalImpl(intervalHandle);
        intervalHandle = null;
    }

    return {
        state,
        probe,
        start,
        stop,
    };
}
