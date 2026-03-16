import { AgentRunner } from '../../agents/AgentRunner';

describe('AgentRunner step-contract process controls', () => {
  const proto = AgentRunner.prototype as any;

  test('computeStepContract returns mutate when batch has remaining files', () => {
    const contract = proto.computeStepContract.call({}, {
      executionPhase: 'EXECUTING_STEP',
      plannedFileBatch: ['src/a.ts', 'src/b.ts'],
      completedBatchFiles: ['src/a.ts'],
      blockedReadCount: 0,
    });

    expect(contract.kind).toBe('mutate');
    expect(contract.instruction).toContain('src/b.ts');
  });

  test('computeStepContract returns validate when phase is VALIDATING_STEP', () => {
    const contract = proto.computeStepContract.call({}, {
      executionPhase: 'VALIDATING_STEP',
      plannedFileBatch: [],
      completedBatchFiles: [],
      blockedReadCount: 0,
    });

    expect(contract.kind).toBe('validate');
    expect(contract.instruction).toContain('Run validation/diagnostics now');
  });

  test('filterToolsByStepContract narrows tool list for mutate', () => {
    const tools = [
      { name: 'write_file' },
      { name: 'edit_file' },
      { name: 'list_files' },
      { name: 'search_files' },
      { name: 'run_command' },
      { name: 'update_task_state' },
    ] as any;

    const filtered = proto.filterToolsByStepContract.call({}, tools, 'mutate');
    const names = filtered.map((t: any) => t.name);

    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('run_command');
    expect(names).toContain('update_task_state');
    expect(names).not.toContain('list_files');
    expect(names).not.toContain('search_files');
  });

  test('filterToolsByStepContract narrows tool list for validate', () => {
    const tools = [
      { name: 'run_command' },
      { name: 'get_diagnostics' },
      { name: 'git_diff' },
      { name: 'write_file' },
      { name: 'edit_file' },
      { name: 'list_files' },
    ] as any;

    const filtered = proto.filterToolsByStepContract.call({}, tools, 'validate');
    const names = filtered.map((t: any) => t.name);

    expect(names).toEqual(expect.arrayContaining(['run_command', 'get_diagnostics', 'git_diff']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('list_files');
  });

  test('extractFileBlocksFromAssistantText parses file/path fenced blocks and skips invalid', () => {
    const text = [
      'File: src/a.ts',
      '```ts',
      'export const a = 1;',
      '```',
      '',
      '```src/b.ts',
      'export const b = 2;',
      '```',
      '',
      'Path: .bormagi/secret.md',
      '```md',
      'should be ignored by persistence path checks',
      '```',
      '',
      'Path: src/noext',
      '```txt',
      'no extension should be ignored by extractor path validation',
      '```',
    ].join('\n');

    const extracted = proto.extractFileBlocksFromAssistantText.call({}, text);
    expect(extracted).toHaveLength(3);
    const paths = extracted.map((f: any) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', '.bormagi/secret.md']));
    expect(paths).not.toContain('src/noext');
  });
});
