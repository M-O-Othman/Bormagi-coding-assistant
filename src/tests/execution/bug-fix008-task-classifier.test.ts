/**
 * bug-fix008: Task classifier tests for requirements_driven_build
 * and READY-state hard override.
 */
import { classifyTask } from '../../agents/execution/TaskClassifier';
import { classifyTurnIntent, isNonMutatingIntent, isContinuationIntent } from '../../agents/execution/TurnIntentClassifier';

describe('TaskClassifier — requirements_driven_build (bug-fix-008 Fix 1)', () => {
  test('classifies requirements-driven implementation in docs_only workspace as requirements_driven_build', () => {
    const result = classifyTask(
      'start implementing the system defined in requirements.md',
      'code',
      'docs_only',
      ['requirements.md'],
    );
    expect(result).toBe('requirements_driven_build');
  });

  test('classifies "implement from requirements" in greenfield workspace as requirements_driven_build', () => {
    const result = classifyTask(
      'implement the system from requirements.md',
      'code',
      'greenfield',
      ['requirements.md'],
    );
    expect(result).toBe('requirements_driven_build');
  });

  test('does NOT classify as requirements_driven_build when requirements.md is not in resolvedInputs', () => {
    const result = classifyTask(
      'start implementing the system defined in requirements.md',
      'code',
      'docs_only',
      [], // not preloaded
    );
    // Falls through to greenfield or patch — but not requirements_driven_build
    expect(result).not.toBe('requirements_driven_build');
  });

  test('does NOT classify as requirements_driven_build in mature workspace', () => {
    const result = classifyTask(
      'implement the system defined in requirements.md',
      'code',
      'mature',
      ['requirements.md'],
    );
    expect(result).not.toBe('requirements_driven_build');
  });

  test('does NOT classify diagnostic message as requirements_driven_build', () => {
    const result = classifyTask(
      'why did you stop?',
      'code',
      'docs_only',
      ['requirements.md'],
    );
    expect(result).not.toBe('requirements_driven_build');
  });

  test('build from spec.md in docs_only workspace → requirements_driven_build', () => {
    const result = classifyTask(
      'build the system from spec.md',
      'code',
      'docs_only',
      ['spec.md'],
    );
    expect(result).toBe('requirements_driven_build');
  });

  // Existing classifier rules must still work unchanged
  test('plain scaffold → greenfield_scaffold (unchanged)', () => {
    expect(classifyTask('scaffold a new express app', 'code')).toBe('greenfield_scaffold');
  });

  test('plan mode → plan_only (unchanged)', () => {
    expect(classifyTask('implement everything', 'plan')).toBe('plan_only');
  });

  test('existing project fix → existing_project_patch (unchanged)', () => {
    expect(classifyTask('fix the bug in login handler', 'code')).toBe('existing_project_patch');
  });
});

describe('TurnIntentClassifier (bug-fix-008 Fix 4 / bug-fix-009 Fix 1.6)', () => {
  test('"continue" → continue_task', () => {
    expect(classifyTurnIntent('continue')).toBe('continue_task');
    expect(classifyTurnIntent('Continue.')).toBe('continue_task');
    expect(classifyTurnIntent('proceed')).toBe('continue_task');
    expect(classifyTurnIntent('keep going')).toBe('continue_task');
  });

  test('"why did you stop?" → diagnostic_question', () => {
    expect(classifyTurnIntent('why did you stop?')).toBe('diagnostic_question');
    expect(classifyTurnIntent('what made you stop?')).toBe('diagnostic_question');
    expect(classifyTurnIntent('why did you pause')).toBe('diagnostic_question');
  });

  test('"what do you want from me?" → diagnostic_question', () => {
    expect(classifyTurnIntent('what do you want from me ?')).toBe('diagnostic_question');
  });

  test('status queries → status_question', () => {
    expect(classifyTurnIntent('what have you done so far?')).toBe('status_question');
    expect(classifyTurnIntent('status')).toBe('status_question');
  });

  test('scope modification → modify_scope', () => {
    expect(classifyTurnIntent('use MySQL instead')).toBe('modify_scope');
  });

  test('diagnostic and status intents are non-mutating', () => {
    expect(isNonMutatingIntent('diagnostic_question')).toBe(true);
    expect(isNonMutatingIntent('status_question')).toBe(true);
    expect(isNonMutatingIntent('continue_task')).toBe(false);
    expect(isNonMutatingIntent('new_task')).toBe(false);
  });

  test('only continue_task is a continuation intent', () => {
    expect(isContinuationIntent('continue_task')).toBe(true);
    expect(isContinuationIntent('diagnostic_question')).toBe(false);
    expect(isContinuationIntent('new_task')).toBe(false);
  });
});
