// src/lib/staffEventRegistry.ts
// New file — introduced by CP-T025 upstream PR.
// Module-level singleton registry for the active IStaffEventEmitter.

import { IStaffEventEmitter, NoopEventEmitter } from './staffEventEmitter';

let _emitter: IStaffEventEmitter = new NoopEventEmitter();

/**
 * Set the active Staff event emitter. Called once by the Iranti SDK constructor
 * when a concrete emitter is provided. Must not be called after startup in
 * production — use resetStaffEventEmitter() in tests only.
 */
export function setStaffEventEmitter(emitter: IStaffEventEmitter): void {
  _emitter = emitter;
}

/**
 * Get the currently active emitter. Returns the NoopEventEmitter if no
 * concrete emitter has been set.
 */
export function getStaffEventEmitter(): IStaffEventEmitter {
  return _emitter;
}

export async function flushStaffEventEmitter(): Promise<void> {
  if (typeof _emitter.flush === 'function') {
    await _emitter.flush();
  }
}

/**
 * Reset to NoopEventEmitter. For use in test beforeEach/afterEach only.
 * Do not call in production code.
 */
export function resetStaffEventEmitter(): void {
  _emitter = new NoopEventEmitter();
}
