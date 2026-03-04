import fs from 'fs';
import { Iranti } from '../sdk';
import { ensureEscalationFolders } from '../lib/escalationPaths';

type SchedulerHandle = {
    stop: () => void;
    started: boolean;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

export async function startArchivistScheduler(iranti: Iranti): Promise<SchedulerHandle> {
    const intervalMs = parsePositiveInt(process.env.IRANTI_ARCHIVIST_INTERVAL_MS, 0);
    const debounceMs = parsePositiveInt(process.env.IRANTI_ARCHIVIST_DEBOUNCE_MS, 60_000);
    const watchEscalations = parseBoolean(process.env.IRANTI_ARCHIVIST_WATCH, true);

    if (intervalMs <= 0 && !watchEscalations) {
        return { started: false, stop: () => {} };
    }

    const escalationPaths = await ensureEscalationFolders();
    let running = false;
    let pendingRun = false;
    let disposed = false;

    let intervalHandle: NodeJS.Timeout | null = null;
    let debounceHandle: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;

    const runMaintenance = async (reason: string): Promise<void> => {
        if (disposed) return;
        if (running) {
            pendingRun = true;
            return;
        }

        running = true;
        try {
            const report = await iranti.runMaintenance();
            console.log(
                `[archivist] run=${reason} processed=${report.escalationsProcessed} ` +
                `expired=${report.expiredArchived} low_conf=${report.lowConfidenceArchived} errors=${report.errors.length}`
            );
        } catch (err) {
            console.error('[archivist] scheduled maintenance failed:', err);
        } finally {
            running = false;
            if (pendingRun && !disposed) {
                pendingRun = false;
                setImmediate(() => {
                    void runMaintenance('pending');
                });
            }
        }
    };

    const scheduleDebouncedRun = (): void => {
        if (disposed) return;
        if (debounceHandle) clearTimeout(debounceHandle);
        debounceHandle = setTimeout(() => {
            debounceHandle = null;
            void runMaintenance('escalation_change');
        }, debounceMs);
    };

    if (intervalMs > 0) {
        intervalHandle = setInterval(() => {
            void runMaintenance('interval');
        }, intervalMs);
    }

    if (watchEscalations) {
        watcher = fs.watch(escalationPaths.active, (_eventType, filename) => {
            if (!filename || !filename.endsWith('.md')) return;
            scheduleDebouncedRun();
        });
    }

    return {
        started: true,
        stop: () => {
            disposed = true;
            if (intervalHandle) clearInterval(intervalHandle);
            if (debounceHandle) clearTimeout(debounceHandle);
            if (watcher) watcher.close();
        },
    };
}
