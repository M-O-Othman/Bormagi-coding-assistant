import { inferStepContract } from '../../agents/execution/StepContract';

describe('inferStepContract', () => {
  test('any tool call → tool contract', () => {
    const c = inferStepContract(['write_file'], 'Some text', 'RUNNING');
    expect(c.kind).toBe('tool');
    expect(c.toolName).toBe('write_file');
  });

  test('no tool + RUNNING phase → pause contract', () => {
    const c = inferStepContract([], 'Let me know what to do next', 'RUNNING');
    expect(c.kind).toBe('pause');
    expect(c.pauseMessage).toContain('Let me know');
  });

  test('no tool + WAITING_FOR_USER_INPUT → pause contract', () => {
    const c = inferStepContract([], 'Waiting for answers', 'WAITING_FOR_USER_INPUT');
    expect(c.kind).toBe('pause');
  });

  test('no tool + COMPLETED → complete contract', () => {
    const c = inferStepContract([], 'All done', 'COMPLETED');
    expect(c.kind).toBe('complete');
    expect(c.completionMessage).toBe('All done');
  });

  test('no tool + BLOCKED_BY_VALIDATION → blocked contract (recoverable)', () => {
    const c = inferStepContract([], 'Validation failed', 'BLOCKED_BY_VALIDATION');
    expect(c.kind).toBe('blocked');
    expect(c.recoverable).toBe(true);
  });

  test('no tool + RECOVERY_REQUIRED → blocked contract (not recoverable)', () => {
    const c = inferStepContract([], 'State corrupted', 'RECOVERY_REQUIRED');
    expect(c.kind).toBe('blocked');
    expect(c.recoverable).toBe(false);
  });

  test('multiple tools → first tool name in contract', () => {
    const c = inferStepContract(['read_file', 'write_file'], '', 'RUNNING');
    expect(c.kind).toBe('tool');
    expect(c.toolName).toBe('read_file');
  });
});
