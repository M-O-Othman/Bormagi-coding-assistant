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
});
