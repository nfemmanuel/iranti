/**
 * Factory for first-party Iranti SDK instances.
 *
 * First-party instances (CLI commands, the MCP server itself) run with strict
 * protocol enforcement and a DbStaffEventEmitter by default. This differs from
 * user-provided SDK instances which may use looser protocol modes and the
 * default NoopEventEmitter.
 *
 * Key export:
 *   - createFirstPartyIranti()  — build a fully-configured internal Iranti instance
 */

import { Iranti, IrantiConfig } from '../sdk';
import { DbStaffEventEmitter } from './dbStaffEventEmitter';

export function createFirstPartyIranti(config: IrantiConfig): Iranti {
    return new Iranti({
        ...config,
        protocolEnforcement: config.protocolEnforcement ?? 'strict',
        staffEventEmitter: config.staffEventEmitter ?? new DbStaffEventEmitter(),
    });
}
