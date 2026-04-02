import { Iranti, IrantiConfig } from '../sdk';
import { DbStaffEventEmitter } from './dbStaffEventEmitter';

export function createFirstPartyIranti(config: IrantiConfig): Iranti {
    return new Iranti({
        ...config,
        protocolEnforcement: config.protocolEnforcement ?? 'strict',
        staffEventEmitter: config.staffEventEmitter ?? new DbStaffEventEmitter(),
    });
}
