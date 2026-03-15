/**
 * Tests for DD5: computeDeterministicNextStep() — write-oriented next-step synthesis.
 * Also covers DD9: controller-side direct dispatch conditions.
 *
 * Note: declare_file_batch is a virtual tool requiring LLM-supplied file list.
 * It cannot be direct-dispatched, so computeDeterministicNextStep returns advisory
 * text only (no nextToolCall) for batch declaration scenarios.
 */
import { ExecutionStateManager, type ExecutionStateData } from '../../agents/ExecutionStateManager';

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  return {
    version: 2,
    agentId: 'test',
    objective: 'Build a project',
    mode: 'code',
    workspaceRoot: '/ws',
    resolvedInputs: [],
    artifactsCreated: [],
    completedSteps: [],
    nextActions: [],
    blockers: [],
    techStack: {},
    iterationsUsed: 0,
    plannedFileBatch: [],
    completedBatchFiles: [],
    updatedAt: new Date().toISOString(),
    executedTools: [],
    ...overrides,
  } as ExecutionStateData;
}

describe('computeDeterministicNextStep', () => {
  const mgr = new ExecutionStateManager('/tmp/test');

  test('approved plan + greenfield + no batch → advisory to declare batch (no nextToolCall)', () => {
    const state = makeState({
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
    });
    const result = mgr.computeDeterministicNextStep(state, 'greenfield');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only, no direct dispatch
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('approved plan + scaffolded + no batch → advisory to declare batch (no nextToolCall)', () => {
    const state = makeState({
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
    });
    const result = mgr.computeDeterministicNextStep(state, 'scaffolded');
    expect(result).not.toBeNull();
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('approved plan + mature → returns null (no deterministic step)', () => {
    const state = makeState({
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
      artifactsCreated: ['existing.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state, 'mature');
    expect(result).toBeNull();
  });

  test('approved plan + batch exists → does NOT re-declare batch', () => {
    const state = makeState({
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
      plannedFileBatch: ['src/index.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state, 'greenfield');
    // Should return write_file for the remaining batch file, not another declare_file_batch
    expect(result).not.toBeNull();
    expect(result!.nextToolCall?.tool).toBe('write_file');
  });

  test('batch exists with remaining files → write_file for next file', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts', 'c.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state, 'scaffolded');
    expect(result).not.toBeNull();
    expect(result!.nextToolCall?.tool).toBe('write_file');
    expect(result!.nextToolCall?.input).toEqual({ path: 'b.ts' });
    expect(result!.nextAction).toContain('b.ts');
  });

  test('batch fully completed → returns null', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts', 'b.ts'],
      artifactsCreated: ['a.ts', 'b.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state, 'scaffolded');
    expect(result).toBeNull();
  });

  test('repeated blocked reads in greenfield with no artifacts → advisory only (no nextToolCall)', () => {
    const state = makeState({ blockedReadCount: 3 });
    const result = mgr.computeDeterministicNextStep(state, 'greenfield');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('repeated blocked reads with existing artifacts → continue implementation', () => {
    const state = makeState({
      blockedReadCount: 3,
      artifactsCreated: ['pkg.json'],
      plannedFileBatch: ['pkg.json'],
      completedBatchFiles: ['pkg.json'],
    });
    const result = mgr.computeDeterministicNextStep(state, 'scaffolded');
    // All batch files done, so batch rule doesn't fire; blocked read rule fires
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Continue implementation');
  });

  test('greenfield with no batch and no artifacts → advisory only (no nextToolCall)', () => {
    const state = makeState({});
    const result = mgr.computeDeterministicNextStep(state, 'greenfield');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('mature workspace with no batch → returns null', () => {
    const state = makeState({ artifactsCreated: ['main.ts'] });
    const result = mgr.computeDeterministicNextStep(state, 'mature');
    expect(result).toBeNull();
  });

  test('low blockedReadCount in mature → returns null', () => {
    const state = makeState({ blockedReadCount: 1, artifactsCreated: ['x.ts'] });
    const result = mgr.computeDeterministicNextStep(state, 'mature');
    expect(result).toBeNull();
  });
});

describe('computeNextStep (advisory)', () => {
  const mgr = new ExecutionStateManager('/tmp/test');

  test('after reading spec file in greenfield → advisory to declare batch (no nextToolCall)', () => {
    const state = makeState({});
    const result = mgr.computeNextStep(state, 'read_file', 'docs/spec.md', 'spec content', 'greenfield');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('after reading plan file in mature → write-oriented advice', () => {
    const state = makeState({ artifactsCreated: ['main.ts'] });
    const result = mgr.computeNextStep(state, 'read_file', 'plan.md', 'plan content', 'mature');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Write');
  });

  test('after reading generic file → write or edit advice', () => {
    const state = makeState({});
    const result = mgr.computeNextStep(state, 'read_file', 'src/utils.ts', 'code', 'mature');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Write or edit');
  });

  test('after list_files in greenfield → advisory to declare batch (no nextToolCall)', () => {
    const state = makeState({});
    const result = mgr.computeNextStep(state, 'list_files', undefined, 'files list', 'greenfield');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('after list_files in mature → read or write advice', () => {
    const state = makeState({});
    const result = mgr.computeNextStep(state, 'list_files', undefined, 'files list', 'mature');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Read the most relevant file');
  });

  test('after write_file with remaining batch → next batch file', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const result = mgr.computeNextStep(state, 'write_file', 'a.ts', 'written', 'scaffolded');
    expect(result).not.toBeNull();
    expect(result!.nextToolCall?.tool).toBe('write_file');
    expect(result!.nextToolCall?.input).toEqual({ path: 'b.ts' });
  });

  test('after edit_file → verify advice', () => {
    const state = makeState({});
    const result = mgr.computeNextStep(state, 'edit_file', 'src/x.ts', 'edited', 'mature');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Verify');
  });

  test('unknown tool → returns null', () => {
    const state = makeState({});
    const result = mgr.computeNextStep(state, 'run_command', undefined, 'output', 'mature');
    expect(result).toBeNull();
  });
});
