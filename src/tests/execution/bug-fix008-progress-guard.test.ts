/**
 * bug-fix008: ProgressGuard tests — update_task_state no longer counts as progress.
 */
import { ProgressGuard } from '../../agents/execution/ProgressGuard';
import { countsAsMaterialProgress } from '../../agents/execution/ProgressGuard';

describe('ProgressGuard — update_task_state exclusion (bug-fix-009 Fix 1.5)', () => {
  test('update_task_state does NOT count as PROGRESS', () => {
    const guard = new ProgressGuard();
    const verdict = guard.evaluate(true, 'update_task_state', 'success');
    expect(verdict).toBe('NON_PROGRESS');
  });

  test('write_file still counts as PROGRESS', () => {
    const guard = new ProgressGuard();
    const verdict = guard.evaluate(true, 'write_file', 'success');
    expect(verdict).toBe('PROGRESS');
  });

  test('edit_file still counts as PROGRESS', () => {
    const guard = new ProgressGuard();
    const verdict = guard.evaluate(true, 'edit_file', 'success');
    expect(verdict).toBe('PROGRESS');
  });

  test('multi_edit still counts as PROGRESS', () => {
    const guard = new ProgressGuard();
    const verdict = guard.evaluate(true, 'multi_edit', 'success');
    expect(verdict).toBe('PROGRESS');
  });

  test('create_document still counts as PROGRESS', () => {
    const guard = new ProgressGuard();
    const verdict = guard.evaluate(true, 'create_document', 'success');
    expect(verdict).toBe('PROGRESS');
  });

  test('consecutive update_task_state calls trigger RECOVERY_REQUIRED after MAX_NON_PROGRESS', () => {
    const guard = new ProgressGuard();
    guard.evaluate(true, 'update_task_state', 'success'); // non-progress
    guard.evaluate(true, 'update_task_state', 'success'); // non-progress
    const verdict = guard.evaluate(true, 'update_task_state', 'success'); // triggers recovery
    expect(verdict).toBe('RECOVERY_REQUIRED');
  });

  test('write_file resets the non-progress counter', () => {
    const guard = new ProgressGuard();
    guard.evaluate(true, 'update_task_state', 'success');
    guard.evaluate(true, 'update_task_state', 'success');
    guard.evaluate(true, 'write_file', 'success'); // resets counter
    const verdict = guard.evaluate(true, 'update_task_state', 'success');
    // only 1 non-progress after reset, should not trigger recovery
    expect(verdict).toBe('NON_PROGRESS');
  });
});

describe('countsAsMaterialProgress helper (bug-fix-009 Fix 1.5)', () => {
  test('write_file success → true', () => {
    expect(countsAsMaterialProgress('write_file', 'success')).toBe(true);
  });

  test('edit_file success → true', () => {
    expect(countsAsMaterialProgress('edit_file', 'success')).toBe(true);
  });

  test('update_task_state success → false', () => {
    expect(countsAsMaterialProgress('update_task_state', 'success')).toBe(false);
  });

  test('declare_file_batch success → false', () => {
    expect(countsAsMaterialProgress('declare_file_batch', 'success')).toBe(false);
  });

  test('write_file error → false', () => {
    expect(countsAsMaterialProgress('write_file', 'error')).toBe(false);
  });

  test('list_files success → false', () => {
    expect(countsAsMaterialProgress('list_files', 'success')).toBe(false);
  });
});
