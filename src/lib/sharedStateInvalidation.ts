/**
 * Cross-process shared-state invalidation for Iranti's Attendant cache.
 *
 * When a fact is written, other processes watching the same entity need to
 * invalidate their in-memory cache. This module uses PostgreSQL LISTEN/NOTIFY
 * on the `iranti_shared_state_invalidation` channel to broadcast update signals
 * across all processes sharing the same database.
 *
 * Architecture:
 *   - Listener: one dedicated pg.Client per process for LISTEN (auto-reconnects).
 *   - Notifier: one dedicated pg.Client per process for pg_notify() sends.
 *   - In-process: notifySharedEntityUpdated() for writes within the same process.
 *   - Cross-process: broadcastSharedEntityUpdated() for external writers.
 *   - Self-filter: messages from the current process are ignored (CROSS_PROCESS_SOURCE).
 *
 * Key exports:
 *   - registerSharedStateInvalidationObserver()    — attach a watcher (starts listener)
 *   - unregisterSharedStateInvalidationObserver()  — detach; shuts down listener when last
 *   - notifySharedEntityUpdated()                  — in-process cache invalidation
 *   - broadcastSharedEntityUpdated()               — cross-process invalidation via pg_notify
 *   - shutdownSharedStateInvalidationListener()    — clean teardown before process exit
 */

import { Client } from 'pg';

export interface SharedStateInvalidationObserver {
    isWatchingEntity(entity: string): boolean;
    notifySharedEntityUpdated(entity: string, key: string): void;
}

const observers = new Map<string, SharedStateInvalidationObserver>();
const CROSS_PROCESS_INVALIDATION_CHANNEL = 'iranti_shared_state_invalidation';
const CROSS_PROCESS_SOURCE = `${process.pid}:${Math.random().toString(36).slice(2)}`;

let listenerClient: Client | null = null;
let listenerStarted = false;
let listenerStarting: Promise<void> | null = null;
let listenerShutdownRequested = false;
let notifierClient: Client | null = null;
let notifierStarting: Promise<Client> | null = null;

type SharedStateInvalidationPayload = {
    entity: string;
    key: string;
    source: string;
};

export function registerSharedStateInvalidationObserver(
    agentId: string,
    observer: SharedStateInvalidationObserver,
): void {
    observers.set(agentId, observer);
    listenerShutdownRequested = false;
    void ensureCrossProcessInvalidationListener();
}

export function unregisterSharedStateInvalidationObserver(agentId: string): void {
    observers.delete(agentId);
    if (observers.size === 0) {
        void shutdownSharedStateInvalidationListener();
    }
}

export function notifySharedEntityUpdated(entity: string, key: string): void {
    for (const observer of observers.values()) {
        if (!observer.isWatchingEntity(entity)) continue;
        observer.notifySharedEntityUpdated(entity, key);
    }
}

export async function broadcastSharedEntityUpdated(entity: string, key: string): Promise<void> {
    const normalizedEntity = entity.trim();
    const normalizedKey = key.trim();
    if (!normalizedEntity || !normalizedKey) return;

    const payload = JSON.stringify({
        entity: normalizedEntity,
        key: normalizedKey,
        source: CROSS_PROCESS_SOURCE,
    } satisfies SharedStateInvalidationPayload);

    const client = await ensureCrossProcessInvalidationNotifier();
    await client.query('SELECT pg_notify($1, $2)', [
        CROSS_PROCESS_INVALIDATION_CHANNEL,
        payload,
    ]);
}

export async function shutdownSharedStateInvalidationListener(): Promise<void> {
    listenerShutdownRequested = true;
    const current = listenerClient;
    const currentNotifier = notifierClient;
    listenerClient = null;
    listenerStarted = false;
    listenerStarting = null;
    notifierClient = null;
    notifierStarting = null;
    if (current) {
        try {
            await current.end();
        } catch {
            // ignore teardown failures during shutdown
        }
    }
    if (currentNotifier) {
        try {
            await currentNotifier.end();
        } catch {
            // ignore teardown failures during shutdown
        }
    }
}

async function ensureCrossProcessInvalidationListener(): Promise<void> {
    if (listenerStarted) return;
    if (listenerStarting) {
        await listenerStarting;
        return;
    }

    listenerStarting = (async () => {
        const { getDbConnectionString } = require('../library/client') as {
            getDbConnectionString: () => string | null;
        };
        const connectionString = getDbConnectionString();
        if (!connectionString) {
            listenerStarting = null;
            return;
        }

        const client = new Client({
            connectionString,
            application_name: `iranti_invalidation_listener_${process.pid}`,
            keepAlive: true,
        });

        client.on('notification', (message) => {
            if (message.channel !== CROSS_PROCESS_INVALIDATION_CHANNEL) return;
            const parsed = parseSharedStateInvalidationPayload(message.payload);
            if (!parsed || parsed.source === CROSS_PROCESS_SOURCE) return;
            notifySharedEntityUpdated(parsed.entity, parsed.key);
        });

        client.on('error', (error) => {
            console.warn(`[shared-state] cross-process invalidation listener error: ${error instanceof Error ? error.message : String(error)}`);
            listenerStarted = false;
            listenerClient = null;
            listenerStarting = null;
            if (!listenerShutdownRequested && observers.size > 0) {
                void ensureCrossProcessInvalidationListener();
            }
        });

        client.on('end', () => {
            listenerStarted = false;
            listenerClient = null;
            listenerStarting = null;
            if (!listenerShutdownRequested && observers.size > 0) {
                void ensureCrossProcessInvalidationListener();
            }
        });

        await client.connect();
        await client.query(`LISTEN ${CROSS_PROCESS_INVALIDATION_CHANNEL}`);
        const stream = (client as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream;
        stream?.unref?.();

        listenerClient = client;
        listenerStarted = true;
        listenerStarting = null;
    })();

    await listenerStarting;
}

async function ensureCrossProcessInvalidationNotifier(): Promise<Client> {
    if (notifierClient) return notifierClient;
    if (notifierStarting) return notifierStarting;

    notifierStarting = (async () => {
        const { getDbConnectionString } = require('../library/client') as {
            getDbConnectionString: () => string | null;
        };
        const connectionString = getDbConnectionString();
        if (!connectionString) {
            throw new Error('Cross-process invalidation notifier cannot start before the DB is initialized.');
        }

        const client = new Client({
            connectionString,
            application_name: `iranti_invalidation_notifier_${process.pid}`,
            keepAlive: true,
        });

        client.on('error', () => {
            notifierClient = null;
            notifierStarting = null;
        });
        client.on('end', () => {
            notifierClient = null;
            notifierStarting = null;
        });

        await client.connect();
        const stream = (client as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream;
        stream?.unref?.();

        notifierClient = client;
        notifierStarting = null;
        return client;
    })();

    return notifierStarting;
}

function parseSharedStateInvalidationPayload(raw: string | undefined): SharedStateInvalidationPayload | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<SharedStateInvalidationPayload>;
        if (typeof parsed.entity !== 'string' || typeof parsed.key !== 'string' || typeof parsed.source !== 'string') {
            return null;
        }
        const entity = parsed.entity.trim();
        const key = parsed.key.trim();
        const source = parsed.source.trim();
        if (!entity || !key || !source) return null;
        return { entity, key, source };
    } catch {
        return null;
    }
}
