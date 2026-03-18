/**
 * Tests for DD5: computeDeterministicNextStep() — write-oriented next-step synthesis.
 * Also covers DD9: controller-side direct dispatch conditions.
 *
 * Note: declare_file_batch is a virtual tool requiring LLM-supplied file list.
 * It cannot be direct-dispatched, so computeDeterministicNextStep returns advisory
 * text only (no nextToolCall) for batch declaration scenarios.
 *
 * After the template-as-authority refactor, workspace type is no longer passed.
 * Instead, the template's requiresBatch flag (via state.taskTemplate) drives decisions.
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

  test('approved plan + requiresBatch template + no batch → advisory to declare batch (no nextToolCall)', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold', // requiresBatch=true
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only, no direct dispatch
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('approved plan + multi_file_refactor template + no batch → advisory to declare batch', () => {
    const state = makeState({
      taskTemplate: 'multi_file_refactor', // requiresBatch=true
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('approved plan + non-batch template → returns null (no deterministic step)', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch', // requiresBatch=false
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
      artifactsCreated: ['existing.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).toBeNull();
  });

  test('approved plan + batch exists → does NOT re-declare batch', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      approvedPlanPath: 'plan.md',
      artifactStatus: { 'plan.md': 'approved' },
      plannedFileBatch: ['src/index.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    // Should return advisory text for the remaining batch file, not another declare_file_batch.
    // write_file cannot be direct-dispatched (needs LLM-generated content), so nextToolCall is a hint.
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('index.ts');
  });

  test('batch exists with remaining files → advisory text for next file', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      plannedFileBatch: ['a.ts', 'b.ts', 'c.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('b.ts');
  });

  test('batch fully completed → returns null', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts', 'b.ts'],
      artifactsCreated: ['a.ts', 'b.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).toBeNull();
  });

  test('repeated blocked reads + requiresBatch + no artifacts → advisory only (no nextToolCall)', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold', // requiresBatch=true
      blockedReadCount: 3,
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('repeated blocked reads with existing artifacts → continue implementation', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      blockedReadCount: 3,
      artifactsCreated: ['pkg.json'],
      plannedFileBatch: ['pkg.json'],
      completedBatchFiles: ['pkg.json'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    // All batch files done, so batch rule doesn't fire; blocked read rule fires
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Continue implementation');
  });

  test('requiresBatch template + no batch + no artifacts → advisory to declare batch', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold', // requiresBatch=true
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('non-batch template with no batch → returns null', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch', // requiresBatch=false
      artifactsCreated: ['main.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).toBeNull();
  });

  test('non-batch template + low blockedReadCount → returns null', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch', // requiresBatch=false
      blockedReadCount: 1,
      artifactsCreated: ['x.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).toBeNull();
  });

  test('repeated blocked reads + non-batch template + no artifacts → write directly', () => {
    const state = makeState({
      taskTemplate: 'single_file_creation', // requiresBatch=false
      blockedReadCount: 3,
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Write the requested file');
  });
});

describe('computeNextStep (advisory)', () => {
  const mgr = new ExecutionStateManager('/tmp/test');

  test('after reading spec file + requiresBatch → advisory to declare batch', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold', // requiresBatch=true
    });
    const result = mgr.computeNextStep(state, 'read_file', 'docs/spec.md', 'spec content');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('after reading plan file + non-batch template → write-oriented advice', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch', // requiresBatch=false
      artifactsCreated: ['main.ts'],
    });
    const result = mgr.computeNextStep(state, 'read_file', 'plan.md', 'plan content');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Write');
  });

  test('after reading generic file → write or edit advice', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch',
    });
    const result = mgr.computeNextStep(state, 'read_file', 'src/utils.ts', 'code');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Write or edit');
  });

  test('after list_files + requiresBatch + no batch → advisory to declare batch', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold', // requiresBatch=true
    });
    const result = mgr.computeNextStep(state, 'list_files', undefined, 'files list');
    expect(result).not.toBeNull();
    // declare_file_batch requires LLM input — advisory only
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('declare_file_batch');
  });

  test('after list_files + non-batch template → read or write advice', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch', // requiresBatch=false
    });
    const result = mgr.computeNextStep(state, 'list_files', undefined, 'files list');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Read the most relevant file');
  });

  test('after write_file with remaining batch → advisory text for next file', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const result = mgr.computeNextStep(state, 'write_file', 'a.ts', 'written');
    expect(result).not.toBeNull();
    // write_file cannot be direct-dispatched — needs LLM-generated content
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('b.ts');
  });

  test('after edit_file → verify advice', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch',
    });
    const result = mgr.computeNextStep(state, 'edit_file', 'src/x.ts', 'edited');
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('Verify');
  });

  test('unknown tool → returns null', () => {
    const state = makeState({
      taskTemplate: 'existing_project_patch',
    });
    const result = mgr.computeNextStep(state, 'run_command', undefined, 'output');
    expect(result).toBeNull();
  });
});
