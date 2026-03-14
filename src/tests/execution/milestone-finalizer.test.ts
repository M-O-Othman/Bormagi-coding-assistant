import { MilestoneFinalizer } from '../../agents/execution/MilestoneFinalizer';
import type { ExecutionStateData } from '../../agents/ExecutionStateManager';
import type { StepContract } from '../../agents/execution/StepContract';

const messages = {
  waitAutoDetected: 'Deliverable written — pausing for your input.',
  batchCheckpoint: 'Batch checkpoint reached — running validation.',
  batchComplete: 'All batch files written — validating output.',
};

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  return {
    version: 2,
    agentId: 'test',
    objective: 'test objective',
    mode: 'code',
    workspaceRoot: '/tmp',
    resolvedInputs: [],
    artifactsCreated: [],
    completedSteps: [],
    nextActions: [],
    blockers: [],
    techStack: {},
    iterationsUsed: 0,
    plannedFileBatch: [],
    updatedAt: new Date().toISOString(),
    runPhase: 'RUNNING',
    ...overrides,
  };
}

const toolContract: StepContract = { kind: 'tool', toolName: 'write_file' };
const pauseContract: StepContract = { kind: 'pause', pauseMessage: 'waiting' };
const completeContract: StepContract = { kind: 'complete', completionMessage: 'done' };
const blockedContract: StepContract = { kind: 'blocked', blockedReason: 'failed', recoverable: true };

describe('MilestoneFinalizer.decide()', () => {
  const fin = new MilestoneFinalizer(messages);

  test('RECOVERY_REQUIRED phase → BLOCK not recoverable', () => {
    const state = makeState({ runPhase: 'RECOVERY_REQUIRED' });
    const d = fin.decide(state, toolContract, 'write_file');
    expect(d.action).toBe('BLOCK');
    if (d.action === 'BLOCK') { expect(d.recoverable).toBe(false); }
  });

  test('WAITING_FOR_USER_INPUT phase → WAIT', () => {
    const state = makeState({ runPhase: 'WAITING_FOR_USER_INPUT', waitStateReason: 'need answers' });
    const d = fin.decide(state, toolContract, 'write_file');
    expect(d.action).toBe('WAIT');
  });

  test('COMPLETED phase → COMPLETE', () => {
    const state = makeState({ runPhase: 'COMPLETED' });
    const d = fin.decide(state, completeContract, 'write_file');
    expect(d.action).toBe('COMPLETE');
  });

  test('stepContract.kind === complete → COMPLETE', () => {
    const state = makeState();
    const d = fin.decide(state, completeContract, 'write_file');
    expect(d.action).toBe('COMPLETE');
  });

  test('stepContract.kind === blocked → BLOCK', () => {
    const state = makeState();
    const d = fin.decide(state, blockedContract, 'write_file');
    expect(d.action).toBe('BLOCK');
    if (d.action === 'BLOCK') { expect(d.recoverable).toBe(true); }
  });

  test('stepContract.kind === pause → WAIT', () => {
    const state = makeState();
    const d = fin.decide(state, pauseContract, 'write_file');
    expect(d.action).toBe('WAIT');
  });

  test('all batch files written → VALIDATE', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts', 'b.ts'],
    });
    const d = fin.decide(state, toolContract, 'write_file', 'b.ts');
    expect(d.action).toBe('VALIDATE');
  });

  test('write to open_questions.md → WAIT', () => {
    const state = makeState();
    const d = fin.decide(state, toolContract, 'write_file', 'docs/open_questions.md');
    expect(d.action).toBe('WAIT');
  });

  test('objective contains document then wait + any write → WAIT', () => {
    const state = makeState({ objective: 'document then wait for user review' });
    const d = fin.decide(state, toolContract, 'write_file', 'src/index.ts');
    expect(d.action).toBe('WAIT');
  });

  test('normal write → CONTINUE', () => {
    const state = makeState();
    const d = fin.decide(state, toolContract, 'write_file', 'src/index.ts');
    expect(d.action).toBe('CONTINUE');
  });

  test('non-write tool → CONTINUE', () => {
    const state = makeState();
    const toolC: StepContract = { kind: 'tool', toolName: 'read_file' };
    const d = fin.decide(state, toolC, 'read_file', 'src/index.ts');
    expect(d.action).toBe('CONTINUE');
  });
});
