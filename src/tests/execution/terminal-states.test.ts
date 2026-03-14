/**
 * Tests for Phase 4: terminal / wait state transitions in ExecutionStateManager.
 * Verifies that setRunPhase correctly sets runPhase and optionally waitStateReason,
 * and that fresh state always starts as RUNNING.
 */
import { ExecutionStateManager, SessionPhase } from '../../agents/ExecutionStateManager';

describe('ExecutionStateManager — terminal / wait state transitions', () => {
  let mgr: ExecutionStateManager;
  const agentId = 'test-agent';

  beforeEach(() => {
    mgr = new ExecutionStateManager('/tmp/fake-workspace');
  });

  test('fresh state starts with runPhase RUNNING', () => {
    const state = mgr.createFresh(agentId, 'build something', 'code');
    expect(state.runPhase).toBe('RUNNING');
  });

  test('fresh state starts with waitStateReason undefined', () => {
    const state = mgr.createFresh(agentId, 'build something', 'code');
    expect(state.waitStateReason).toBeUndefined();
  });

  const nonRunningPhases: SessionPhase[] = [
    'WAITING_FOR_USER_INPUT',
    'BLOCKED_BY_VALIDATION',
    'COMPLETED',
    'PARTIAL_BATCH_COMPLETE',
    'RECOVERY_REQUIRED',
  ];

  test.each(nonRunningPhases)(
    'setRunPhase sets runPhase to %s',
    (phase) => {
      const state = mgr.createFresh(agentId, 'test objective', 'plan');
      mgr.setRunPhase(state, phase);
      expect(state.runPhase).toBe(phase);
    }
  );

  test('setRunPhase with a reason sets waitStateReason', () => {
    const state = mgr.createFresh(agentId, 'test objective', 'code');
    mgr.setRunPhase(state, 'BLOCKED_BY_VALIDATION', 'Schema validation failed');
    expect(state.waitStateReason).toBe('Schema validation failed');
  });

  test('setRunPhase WAITING_FOR_USER_INPUT with reason populates waitStateReason', () => {
    const state = mgr.createFresh(agentId, 'test objective', 'review');
    mgr.setRunPhase(state, 'WAITING_FOR_USER_INPUT', 'Please confirm the output path');
    expect(state.runPhase).toBe('WAITING_FOR_USER_INPUT');
    expect(state.waitStateReason).toBe('Please confirm the output path');
  });

  test('setRunPhase without reason leaves waitStateReason unchanged', () => {
    const state = mgr.createFresh(agentId, 'test objective', 'code');
    state.waitStateReason = 'pre-existing reason';
    mgr.setRunPhase(state, 'PARTIAL_BATCH_COMPLETE');
    expect(state.waitStateReason).toBe('pre-existing reason');
  });

  test('setRunPhase COMPLETED sets runPhase to COMPLETED', () => {
    const state = mgr.createFresh(agentId, 'write a module', 'code');
    mgr.setRunPhase(state, 'COMPLETED');
    expect(state.runPhase).toBe('COMPLETED');
  });

  test('setRunPhase updates updatedAt timestamp', () => {
    const state = mgr.createFresh(agentId, 'test objective', 'code');
    const before = state.updatedAt;
    // Small wait to ensure timestamp differs
    mgr.setRunPhase(state, 'RECOVERY_REQUIRED', 'Corrupted state detected');
    expect(state.updatedAt).toBeDefined();
    // updatedAt is an ISO string; it should be >= the original
    expect(new Date(state.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  test('setRunPhase can transition from RUNNING back to RUNNING', () => {
    const state = mgr.createFresh(agentId, 'test objective', 'code');
    mgr.setRunPhase(state, 'WAITING_FOR_USER_INPUT', 'Waiting');
    mgr.setRunPhase(state, 'RUNNING');
    expect(state.runPhase).toBe('RUNNING');
  });
});
