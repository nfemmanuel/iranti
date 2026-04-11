/**
 * Locked file mutation utilities for Iranti.
 *
 * Provides cross-process exclusive write locking via PID-stamped .lock sidecar
 * files. Lock acquisition uses O_EXCL (atomic create) to prevent races.
 * Stale locks are detected by checking file age against `staleMs` and whether
 * the holder PID is still alive — both conditions release the lock automatically.
 *
 * Write pattern: acquire lock → read existing → build new content → write to
 * .tmp → fsync rename over target → release lock. The tmp+rename avoids partial
 * writes visible to readers.
 *
 * Key exports:
 *   - writeTextFileLocked()            — exclusively write a file via a builder callback
 *   - ensureFileContainsLinesLocked()  — append missing lines without duplicates
 *   - DEFAULT_FILE_LOCK_TIMEOUT_MS     — default lock acquisition timeout (5 s)
 *   - DEFAULT_FILE_LOCK_STALE_MS       — default stale lock age threshold (30 s)
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

export const DEFAULT_FILE_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_FILE_LOCK_STALE_MS = 30000;

type LockOptions = {
    timeoutMs?: number;
    staleMs?: number;
};

type LockMetadata = {
    pid: number;
    hostname: string;
    createdAt: string;
};

function lockFilePath(filePath: string): string {
    return `${filePath}.lock`;
}

function lockMetadata(): LockMetadata {
    return {
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
    };
}

function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
    const stat = await fsPromises.stat(lockPath).catch(() => null);
    if (!stat) return false;
    const ageMs = Date.now() - stat.mtimeMs;
    const raw = await fsPromises.readFile(lockPath, 'utf8').catch(() => '');
    let parsed: Partial<LockMetadata> = {};
    if (raw) {
        try {
            parsed = JSON.parse(raw) as Partial<LockMetadata>;
        } catch {
            parsed = {};
        }
    }
    const holderPid = typeof parsed.pid === 'number' ? parsed.pid : null;
    const stale = ageMs > staleMs || (holderPid !== null && !processAlive(holderPid));
    if (!stale) return false;
    await fsPromises.unlink(lockPath).catch(() => undefined);
    return true;
}

async function acquireLock(filePath: string, options: LockOptions = {}): Promise<() => Promise<void>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_FILE_LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_FILE_LOCK_STALE_MS;
    const lockPath = lockFilePath(filePath);
    const deadline = Date.now() + timeoutMs;

    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

    while (true) {
        try {
            const handle = await fsPromises.open(lockPath, 'wx');
            try {
                await handle.writeFile(`${JSON.stringify(lockMetadata(), null, 2)}\n`, 'utf8');
            } finally {
                await handle.close();
            }
            return async () => {
                await fsPromises.unlink(lockPath).catch(() => undefined);
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') {
                throw error;
            }

            const removed = await removeStaleLock(lockPath, staleMs);
            if (removed) {
                continue;
            }

            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for file lock: ${lockPath}`);
            }

            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}

export async function writeTextFileLocked(
    filePath: string,
    buildContent: (existing: string) => string | Promise<string>,
    options: LockOptions = {},
): Promise<void> {
    const release = await acquireLock(filePath, options);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        const existing = fs.existsSync(filePath) ? await fsPromises.readFile(filePath, 'utf8') : '';
        const content = await buildContent(existing);
        await fsPromises.writeFile(tmpPath, content, { encoding: 'utf8', flag: 'w' });
        await fsPromises.rename(tmpPath, filePath);
    } catch (error) {
        await fsPromises.unlink(tmpPath).catch(() => undefined);
        throw error;
    } finally {
        await release();
    }
}

export async function ensureFileContainsLinesLocked(
    filePath: string,
    requiredLines: string[],
    options: LockOptions = {},
): Promise<void> {
    await writeTextFileLocked(filePath, (existingRaw) => {
        const existingLines = existingRaw.split(/\r?\n/);
        const existing = new Set(existingLines);
        const missing = requiredLines.filter((line) => !existing.has(line));

        if (missing.length === 0) {
            return existingRaw;
        }

        const prefix = existingRaw.length > 0 ? `${existingRaw.trimEnd()}\n` : '';
        return `${prefix}${missing.join('\n')}\n`;
    }, options);
}
