import { classifyTask } from '../../agents/execution/TaskClassifier';

describe('TaskClassifier', () => {
  // plan mode always → plan_only
  test('plan mode always classifies as plan_only', () => {
    expect(classifyTask('write some code', 'plan')).toBe('plan_only');
    expect(classifyTask('scaffold a new project', 'plan')).toBe('plan_only');
  });

  // ask mode always → investigate_then_report
  test('ask mode always classifies as investigate_then_report', () => {
    expect(classifyTask('what does this function do', 'ask')).toBe('investigate_then_report');
  });

  // document_then_wait
  test('write doc and wait → document_then_wait', () => {
    expect(classifyTask('write an open questions document and wait for review', 'code')).toBe('document_then_wait');
    expect(classifyTask('create a summary and stop for input', 'code')).toBe('document_then_wait');
    expect(classifyTask('draft spec then wait', 'code')).toBe('document_then_wait');
  });

  // greenfield_scaffold
  test('scaffold/bootstrap signals → greenfield_scaffold', () => {
    expect(classifyTask('scaffold a new Express app', 'code')).toBe('greenfield_scaffold');
    expect(classifyTask('bootstrap a new project from scratch', 'code')).toBe('greenfield_scaffold');
    expect(classifyTask('create a new React application', 'code')).toBe('greenfield_scaffold');
  });

  // multi_file_refactor
  test('refactor across files → multi_file_refactor', () => {
    expect(classifyTask('refactor across all modules', 'code')).toBe('multi_file_refactor');
    expect(classifyTask('rename the class across every file', 'code')).toBe('multi_file_refactor');
  });

  // investigate_then_report
  test('analyse/investigate without write intent → investigate_then_report', () => {
    expect(classifyTask('analyse what is wrong with the auth module', 'code')).toBe('investigate_then_report');
    expect(classifyTask('review the codebase for security issues', 'code')).toBe('investigate_then_report');
    expect(classifyTask('audit all dependencies', 'code')).toBe('investigate_then_report');
  });

  // plan_only explicit
  test('plan only / no code → plan_only', () => {
    expect(classifyTask('design only, no code', 'code')).toBe('plan_only');
    expect(classifyTask('plan only — do not implement', 'code')).toBe('plan_only');
  });

  // default fallback
  test('default falls back to existing_project_patch', () => {
    expect(classifyTask('fix the bug in the login handler', 'code')).toBe('existing_project_patch');
    expect(classifyTask('add a new utility function to helpers.ts', 'code')).toBe('existing_project_patch');
    expect(classifyTask('implement the missing validation', 'code')).toBe('existing_project_patch');
  });
});
