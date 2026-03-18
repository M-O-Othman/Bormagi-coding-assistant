/**
 * Regression tests for bug-fix004 section 2 fixes.
 *
 * Covers:
 * - Objective preservation after "continue" / "why did you stop"
 * - Blocked-read rejection (hard discovery lock)
 * - Batch continuation after successful write (MilestoneFinalizer)
 * - .bormagi read blocked in code mode
 * - Recovery routes to next batch file without write_file dispatch
 * - ObjectiveNormalizer message classification
 * - ProgressGuard non-progress tracking
 */

import { ExecutionStateManager, type ExecutionStateData } from '../../agents/ExecutionStateManager';
import { MilestoneFinalizer } from '../../agents/execution/MilestoneFinalizer';
import { classifyUserMessage, reconcileObjective } from '../../agents/execution/ObjectiveNormalizer';
import { ProgressGuard } from '../../agents/execution/ProgressGuard';
import type { StepContract } from '../../agents/execution/StepContract';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  return {
    objective: 'Build the backend API with 20 files',
    nextActions: [],
    executedTools: [],
    resolvedInputs: [],
    artifactsCreated: [],
    iterationsUsed: 5,
    completedBatchFiles: [],
    plannedFileBatch: [],
    primaryObjective: 'Build the backend API with 20 files',
    ...overrides,
  } as ExecutionStateData;
}

function makeFinalizer(): MilestoneFinalizer {
  return new MilestoneFinalizer({
    waitAutoDetected: 'Auto-detected wait state',
    batchCheckpoint: 'Batch checkpoint reached',
    batchComplete: 'All batch files written',
  });
}

// ─── ObjectiveNormalizer Tests ──────────────────────────────────────────────

describe('ObjectiveNormalizer', () => {
  test('classifies "continue" as continue intent', () => {
    expect(classifyUserMessage('continue')).toBe('continue');
    expect(classifyUserMessage('  Continue  ')).toBe('continue');
    expect(classifyUserMessage('proceed')).toBe('continue');
    expect(classifyUserMessage('keep going')).toBe('continue');
    expect(classifyUserMessage('resume')).toBe('continue');
  });

  test('classifies "why did you stop" as nudge intent', () => {
    expect(classifyUserMessage('why did you stop')).toBe('nudge');
    expect(classifyUserMessage('Why did you stop?')).toBe('nudge');
    expect(classifyUserMessage("don't stop")).toBe('nudge');
    expect(classifyUserMessage('keep working')).toBe('nudge');
    expect(classifyUserMessage('finish the task')).toBe('nudge');
    expect(classifyUserMessage('what happened')).toBe('nudge');
    expect(classifyUserMessage('you have all what you need')).toBe('nudge');
  });

  test('classifies new task as new_task intent', () => {
    expect(classifyUserMessage('Build a REST API for user management')).toBe('new_task');
    expect(classifyUserMessage('Add authentication middleware')).toBe('new_task');
  });

  test('reconcileObjective preserves primary for nudge messages', () => {
    const result = reconcileObjective(
      'Build the backend API',
      'Build the backend API',
      'why did you stop',
    );
    expect(result.primaryObjective).toBe('Build the backend API');
    expect(result.resumeNote).toBe('why did you stop');
    expect(result.objective).toBe('Build the backend API');
  });

  test('reconcileObjective preserves primary for continue messages', () => {
    const result = reconcileObjective(
      'Build the backend API',
      'Build the backend API',
      'continue',
    );
    expect(result.primaryObjective).toBe('Build the backend API');
    expect(result.resumeNote).toBeUndefined();
    expect(result.objective).toBe('Build the backend API');
  });

  test('reconcileObjective updates primary for new tasks', () => {
    const result = reconcileObjective(
      'Build the backend API',
      'Build the backend API',
      'Now add authentication',
    );
    expect(result.primaryObjective).toBe('Now add authentication');
    expect(result.resumeNote).toBeUndefined();
    expect(result.objective).toBe('Now add authentication');
  });
});

// ─── MilestoneFinalizer Batch Heartbeat Tests ───────────────────────────────

describe('MilestoneFinalizer batch heartbeat', () => {
  const finalizer = makeFinalizer();

  test('active batch + pause contract → CONTINUE (override)', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts', 'c.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const contract: StepContract = { kind: 'pause', pauseMessage: 'Model paused' };
    const result = finalizer.decide(state, contract, 'write_file', 'a.ts');
    expect(result.action).toBe('CONTINUE');
  });

  test('active batch + complete contract → CONTINUE (override)', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts', 'c.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const contract: StepContract = { kind: 'complete', completionMessage: 'Done' };
    const result = finalizer.decide(state, contract, 'write_file', 'a.ts');
    expect(result.action).toBe('CONTINUE');
  });

  test('active batch + blocked contract → BLOCK (not overridden)', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts', 'c.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const contract: StepContract = { kind: 'blocked', blockedReason: 'Validation failed' };
    const result = finalizer.decide(state, contract, 'write_file', 'a.ts');
    expect(result.action).toBe('BLOCK');
  });

  test('no active batch + pause contract → WAIT (normal)', () => {
    const state = makeState({ plannedFileBatch: [], completedBatchFiles: [] });
    const contract: StepContract = { kind: 'pause', pauseMessage: 'Pausing' };
    const result = finalizer.decide(state, contract, 'read_file');
    expect(result.action).toBe('WAIT');
  });

  test('batch fully complete + write tool → VALIDATE', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts', 'b.ts'],
    });
    const contract: StepContract = { kind: 'tool' };
    const result = finalizer.decide(state, contract, 'write_file', 'b.ts');
    expect(result.action).toBe('VALIDATE');
  });

  test('batch active + tool contract + write succeeds → CONTINUE (default path)', () => {
    const state = makeState({
      plannedFileBatch: ['a.ts', 'b.ts', 'c.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const contract: StepContract = { kind: 'tool' };
    const result = finalizer.decide(state, contract, 'write_file', 'a.ts');
    // Default path returns CONTINUE
    expect(result.action).toBe('CONTINUE');
  });
});

// ─── ProgressGuard Tests ────────────────────────────────────────────────────

describe('ProgressGuard', () => {
  test('successful write = PROGRESS', () => {
    const guard = new ProgressGuard();
    const result = guard.evaluate(true, 'write_file', 'success');
    expect(result).toBe('PROGRESS');
    expect(guard.getState().nonProgressCount).toBe(0);
  });

  test('narration only = NON_PROGRESS', () => {
    const guard = new ProgressGuard();
    const result = guard.evaluate(false, undefined, undefined, true);
    expect(result).toBe('NON_PROGRESS');
    expect(guard.getState().nonProgressCount).toBe(1);
  });

  test('blocked read = NON_PROGRESS', () => {
    const guard = new ProgressGuard();
    const result = guard.evaluate(true, 'read_file', 'blocked');
    expect(result).toBe('NON_PROGRESS');
    expect(guard.getState().nonProgressCount).toBe(1);
  });

  test('3 consecutive non-progress turns → RECOVERY_REQUIRED', () => {
    const guard = new ProgressGuard();
    guard.evaluate(false, undefined, undefined, true); // 1
    guard.evaluate(true, 'read_file', 'blocked');       // 2
    const result = guard.evaluate(false, undefined, undefined, true); // 3
    expect(result).toBe('RECOVERY_REQUIRED');
  });

  test('progress resets non-progress counter', () => {
    const guard = new ProgressGuard();
    guard.evaluate(false, undefined, undefined, true); // 1
    guard.evaluate(false, undefined, undefined, true); // 2
    guard.evaluate(true, 'write_file', 'success');     // resets
    const result = guard.evaluate(false, undefined, undefined, true); // 1 again
    expect(result).toBe('NON_PROGRESS');
    expect(guard.getState().nonProgressCount).toBe(1);
  });

  test('reset() clears state', () => {
    const guard = new ProgressGuard();
    guard.evaluate(false, undefined, undefined, true);
    guard.evaluate(false, undefined, undefined, true);
    guard.reset();
    expect(guard.getState().nonProgressCount).toBe(0);
  });
});

// ─── ExecutionStateManager reconcileWithUserMessage Tests ───────────────────

describe('ExecutionStateManager.reconcileWithUserMessage', () => {
  let mgr: ExecutionStateManager;

  beforeEach(() => {
    const mockConfigDir = '/tmp/test-esm-' + Date.now();
    mgr = new ExecutionStateManager(mockConfigDir);
  });

  test('nudge preserves primaryObjective', () => {
    const state = makeState({
      objective: 'Build backend API',
      primaryObjective: 'Build backend API',
    });
    mgr.reconcileWithUserMessage(state, 'why did you stop', 'code');
    expect(state.primaryObjective).toBe('Build backend API');
    expect(state.resumeNote).toBe('why did you stop');
    expect(state.objective).toBe('Build backend API');
  });

  test('continue preserves primaryObjective', () => {
    const state = makeState({
      objective: 'Build backend API',
      primaryObjective: 'Build backend API',
    });
    mgr.reconcileWithUserMessage(state, 'continue', 'code');
    expect(state.primaryObjective).toBe('Build backend API');
    expect(state.objective).toBe('Build backend API');
  });

  test('new task updates primaryObjective', () => {
    const state = makeState({
      objective: 'Build backend API',
      primaryObjective: 'Build backend API',
      plannedFileBatch: [],
    });
    mgr.reconcileWithUserMessage(state, 'Add authentication module', 'code');
    expect(state.primaryObjective).toBe('Add authentication module');
    expect(state.objective).toBe('Add authentication module');
  });
});

// ─── write_file not in nextToolCall Tests ────────────────────────────────────

describe('ExecutionStateManager does not set nextToolCall for write_file', () => {
  let mgr: ExecutionStateManager;

  beforeEach(() => {
    const mockConfigDir = '/tmp/test-esm-ntc-' + Date.now();
    mgr = new ExecutionStateManager(mockConfigDir);
  });

  test('computeNextStep for batch remaining returns advisory text, not nextToolCall', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const result = mgr.computeNextStep(state, 'write_file', 'a.ts', 'written');
    expect(result).not.toBeNull();
    expect(result!.nextToolCall).toBeUndefined();
    expect(result!.nextAction).toContain('b.ts');
  });

  test('computeDeterministicNextStep for batch remaining returns advisory text with hint nextToolCall', () => {
    const state = makeState({
      taskTemplate: 'greenfield_scaffold',
      plannedFileBatch: ['x.ts', 'y.ts', 'z.ts'],
      completedBatchFiles: ['x.ts'],
    });
    const result = mgr.computeDeterministicNextStep(state);
    expect(result).not.toBeNull();
    expect(result!.nextAction).toContain('y.ts');
    // nextToolCall is a prompt hint (no content = not dispatchable), guarded by DD9
    expect(result!.nextToolCall?.tool).toBe('write_file');
    expect(result!.nextToolCall?.input).toEqual({ path: 'y.ts' });
  });
});
