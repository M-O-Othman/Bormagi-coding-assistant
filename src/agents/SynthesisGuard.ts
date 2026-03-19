import { ExecutionStateData } from './ExecutionStateManager';
import { SessionLedger, collectChangedFiles, collectReadFiles } from './SessionLedger';

export function buildSafeSynthesisPayload(state: ExecutionStateData, ledger: SessionLedger) {
    return {
        objective: state.primaryObjective,
        changedFiles: collectChangedFiles(ledger.entries),
        filesRead: collectReadFiles(ledger.entries),
        lastActualWritePath: state.artifactsCreated?.at(-1) ?? null,
        stopReason: state.stopReason ?? null,
    };
}