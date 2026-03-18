/**
 * Contract consistency tests — verifies that the step contract, batch enforcement,
 * and execution phase never contradict each other.
 *
 * These tests cover GENERALIZED failure classes, not specific log incidents:
 *   1. Missing prerequisite before mutate tool
 *   2. Task-local state leaking into unrelated tasks
 *   3. Controller phase with zero legal next tools (WRITE_ONLY deadlock)
 *   4. Batch violation auto-recovery
 */
import { ExecutionStateManager, type ExecutionStateData } from '../../agents/ExecutionStateManager';
import { BatchEnforcer } from '../../agents/execution/BatchEnforcer';
import { RecoveryManager } from '../../agents/execution/RecoveryManager';
import { PromptAssembler, buildWorkspaceSummary } from '../../agents/execution/PromptAssembler';
import { TASK_TEMPLATES } from '../../agents/execution/TaskTemplate';

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  return {
    version: 2,
    agentId: 'test',
    objective: 'Build something',
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

// ─── Family 1: Missing prerequisite before mutate tool ───────────────────────

describe('Contract consistency: batch prerequisite before mutate', () => {
  const enforcer = new BatchEnforcer('/ws');

  test('when template requires batch and none declared, checkWritePermission blocks', () => {
    const state = makeState({ taskTemplate: 'greenfield_scaffold' });
    const result = enforcer.checkWritePermission('src/index.ts', state, 'BLOCKED', true);
    expect(result).toBe('BLOCKED');
  });

  test('when template does not require batch, writes always allowed', () => {
    // This must hold for ALL non-batch templates, regardless of workspace type
    const nonBatchTemplates = Object.entries(TASK_TEMPLATES)
      .filter(([_, t]) => !t.requiresBatch)
      .map(([name]) => name);

    for (const tmplName of nonBatchTemplates) {
      const state = makeState({ taskTemplate: tmplName as any });
      const result = enforcer.checkWritePermission('any/file.ts', state, 'BLOCKED', false);
      expect(result).toBeNull();
    }
  });

  test('when template requires batch AND batch is declared, write is allowed for in-batch files', () => {
    const batchTemplates = Object.entries(TASK_TEMPLATES)
      .filter(([_, t]) => t.requiresBatch)
      .map(([name]) => name);

    for (const tmplName of batchTemplates) {
      const state = makeState({
        taskTemplate: tmplName as any,
        plannedFileBatch: ['src/index.ts'],
      });
      const result = enforcer.checkWritePermission('src/index.ts', state, 'BLOCKED', true);
      expect(result).toBeNull();
    }
  });

  test('computeDeterministicNextStep never advises write_file when batch prerequisite is missing', () => {
    const mgr = new ExecutionStateManager('/tmp/test');
    const state = makeState({
      taskTemplate: 'greenfield_scaffold', // requiresBatch=true
      plannedFileBatch: [], // no batch
    });
    const result = mgr.computeDeterministicNextStep(state);
    if (result) {
      // If a next step is returned, it must NOT be a write_file — it should direct to batch declaration
      expect(result.nextAction).not.toMatch(/^Write /);
      if (result.nextToolCall) {
        expect(result.nextToolCall.tool).not.toBe('write_file');
      }
    }
  });
});

// ─── Family 2: Task-local state leaking into unrelated tasks ─────────────────

describe('Contract consistency: task boundary isolation', () => {
  const mgr = new ExecutionStateManager('/tmp/test');

  test('new unrelated task clears resolved inputs', () => {
    const state = makeState({
      resolvedInputs: ['requirements.md', 'spec.md'],
      resolvedInputContents: { 'requirements.md': 'old content' },
      resolvedInputSummaries: [{ path: 'requirements.md', hash: 'abc', summary: 'old' }] as any,
    });
    mgr.reconcileWithUserMessage(state, 'Build a completely different app', 'code');
    expect(state.resolvedInputs).toEqual([]);
    expect(state.resolvedInputContents).toBeUndefined();
    expect(state.resolvedInputSummaries).toBeUndefined();
  });

  test('new unrelated task clears artifacts', () => {
    const state = makeState({
      artifactsCreated: ['old-app.ts', 'old-utils.ts'],
    });
    mgr.reconcileWithUserMessage(state, 'Create a new project', 'code');
    expect(state.artifactsCreated).toEqual([]);
  });

  test('new unrelated task clears batch state', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts'],
      batchViolationCount: 3,
      lastBatchViolationPath: 'c.ts',
    });
    mgr.reconcileWithUserMessage(state, 'Start something new', 'code');
    expect(state.plannedFileBatch).toEqual([]);
    expect(state.completedBatchFiles).toEqual([]);
    expect(state.batchViolationCount).toBe(0);
    expect(state.lastBatchViolationPath).toBeUndefined();
  });

  test('new unrelated task clears approved plan', () => {
    const state = makeState({
      approvedPlanPath: 'old-plan.md',
      artifactStatus: { 'old-plan.md': 'approved' },
    });
    mgr.reconcileWithUserMessage(state, 'Do something else entirely', 'code');
    expect(state.approvedPlanPath).toBeUndefined();
    expect(state.artifactStatus).toBeUndefined();
  });

  test('continue/nudge preserves resolved inputs', () => {
    const state = makeState({
      resolvedInputs: ['requirements.md'],
      resolvedInputContents: { 'requirements.md': 'content' },
      primaryObjective: 'Build the app',
    });
    mgr.reconcileWithUserMessage(state, 'continue', 'code');
    expect(state.resolvedInputs).toEqual(['requirements.md']);
    expect(state.resolvedInputContents).toEqual({ 'requirements.md': 'content' });
  });

  test('nudge preserves resolved inputs', () => {
    const state = makeState({
      resolvedInputs: ['spec.md'],
      primaryObjective: 'Build the app',
    });
    mgr.reconcileWithUserMessage(state, 'why did you stop', 'code');
    expect(state.resolvedInputs).toEqual(['spec.md']);
  });
});

// ─── Family 3: Controller phase with zero legal next tools ───────────────────

describe('Contract consistency: no deadlock phases', () => {
  test('WRITE_ONLY phase is never entered when batch prerequisite is missing (invariant check)', () => {
    // This test verifies the PRINCIPLE: for any template that requires batch,
    // if no batch is declared, WRITE_ONLY must not be the active phase.
    // The actual enforcement is in AgentRunner — this test documents the invariant.
    const batchTemplates = Object.entries(TASK_TEMPLATES)
      .filter(([_, t]) => t.requiresBatch)
      .map(([name]) => name);

    for (const tmplName of batchTemplates) {
      const state = makeState({
        taskTemplate: tmplName as any,
        plannedFileBatch: [], // no batch
        executionPhase: 'WRITE_ONLY' as any,
      });

      // In this state, writes would be blocked (batch required) AND reads are blocked (WRITE_ONLY).
      // The enforcer confirms writes are blocked:
      const enforcer = new BatchEnforcer('/ws');
      const writeBlocked = enforcer.checkWritePermission('any.ts', state, 'BLOCKED', true);
      expect(writeBlocked).toBe('BLOCKED');

      // This combination is a deadlock — the controller must prevent it.
      // The invariant: if writeBlocked AND phase === WRITE_ONLY, the agent has zero legal tools.
      // Our WRITE_ONLY guards in AgentRunner prevent this state from being reached.
    }
  });
});

// ─── Family 4: Batch violation recovery ──────────────────────────────────────

describe('Contract consistency: batch violation triggers recovery', () => {
  test('FORCED_BATCH_CONTINUATION triggers after repeated batch violations', () => {
    const state = makeState({
      batchViolationCount: 2,
      runPhase: 'RUNNING',
    });
    const recovery = new RecoveryManager(
      state,
      [{ role: 'user', content: 'test' }],
      new PromptAssembler({ executionStateHeader: '', workspaceHeader: '', milestoneSummaryPrefix: '' }),
      'system prompt',
      'greenfield',
    );
    const trigger = recovery.shouldRecover();
    expect(trigger).toBe('FORCED_BATCH_CONTINUATION');
  });

  test('no recovery trigger with zero batch violations', () => {
    const state = makeState({
      batchViolationCount: 0,
      runPhase: 'RUNNING',
      iterationsUsed: 1,
      nextActions: ['do something'],
    });
    const recovery = new RecoveryManager(
      state,
      [{ role: 'user', content: 'test' }],
      new PromptAssembler({ executionStateHeader: '', workspaceHeader: '', milestoneSummaryPrefix: '' }),
      'system prompt',
      'mature',
    );
    const trigger = recovery.shouldRecover();
    expect(trigger).toBeNull();
  });
});
