import { MilestoneFinalizer } from '../../agents/execution/MilestoneFinalizer';
import type { ExecutionStateData } from '../../agents/ExecutionStateManager';

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

describe('MilestoneFinalizer.decide()', () => {
  const fin = new MilestoneFinalizer(messages);

  test('all batch files written → VALIDATE', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts', 'b.ts'],
    });
    const d = fin.decide(state, 'write_file', 'b.ts');
    expect(d.action).toBe('VALIDATE');
  });

  test('write to open_questions.md → WAIT', () => {
    const state = makeState();
    const d = fin.decide(state, 'write_file', 'docs/open_questions.md');
    expect(d.action).toBe('WAIT');
  });

  test('objective contains document then wait + any write → WAIT', () => {
    const state = makeState({ objective: 'document then wait for user review' });
    const d = fin.decide(state, 'write_file', 'src/index.ts');
    expect(d.action).toBe('WAIT');
  });

  test('normal write → CONTINUE', () => {
    const state = makeState();
    const d = fin.decide(state, 'write_file', 'src/index.ts');
    expect(d.action).toBe('CONTINUE');
  });

  test('non-write tool → CONTINUE', () => {
    const state = makeState();
    const d = fin.decide(state, 'read_file', 'src/index.ts');
    expect(d.action).toBe('CONTINUE');
  });
});
