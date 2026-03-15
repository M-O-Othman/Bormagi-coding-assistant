/**
 * Regression tests for Phase 3: discovery budget enforcement.
 * Verifies that ToolDispatcher blocks discovery tools in code mode after limits.
 */
import { ToolDispatcher } from '../../agents/execution/ToolDispatcher';
import { __setTestData } from '../../data/DataStore';

const mockMCPHost = {
  callTool: jest.fn().mockResolvedValue({ content: [{ text: 'file content' }] })
} as any;
const mockUndoManager = {} as any;
const mockAuditLogger = { logCommand: jest.fn(), logFileWrite: jest.fn() } as any;
const mockOnApproval = jest.fn().mockResolvedValue(true);
const mockOnDiff = jest.fn().mockResolvedValue(true);
const mockOnThought = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  __setTestData({
    executionMessages: {
      toolBlocked: {
        bormagiPath: '[BLOCKED] bormagi',
        reread: '[BLOCKED] reread',
        budgetExhausted: '[BUDGET EXHAUSTED] Discovery limit reached for this run.',
        offBatch: '[BATCH VIOLATION]',
      },
      toolSummary: { format: '', formatNoPath: '' },
      continueResume: {},
      stateContextNote: {},
      validatorIssues: {},
    },
    approvalTools: new Set<string>(),
    toolServerMap: { read_file: 'filesystem', list_files: 'filesystem' },
  });

  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
});

describe('ToolDispatcher — discovery budget (code mode)', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('allows first 2 read_file calls (new whole-file limit is 2)', async () => {
    for (let i = 0; i < 2; i++) {
      const result = await dispatcher.dispatch(
        { id: `${i}`, name: 'read_file', input: { path: `src/file${i}.ts` } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
      expect(result.text).not.toContain('[BUDGET]');
    }
  });

  test('blocks 3rd read_file in code mode (whole-file limit = 2)', async () => {
    for (let i = 0; i < 2; i++) {
      await dispatcher.dispatch(
        { id: `${i}`, name: 'read_file', input: { path: `src/file${i}.ts` } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
    }
    const result = await dispatcher.dispatch(
      { id: '3', name: 'read_file', input: { path: 'src/file3.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result.text).toContain('[BUDGET]');
    expect(result.text).toContain('Whole-file read limit reached');
  });

  test('blocks list_files after 3 calls in code mode (glob limit = 3)', async () => {
    for (let i = 0; i < 3; i++) {
      await dispatcher.dispatch(
        { id: `${i}`, name: 'list_files', input: { directory: `src/dir${i}` } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
    }
    const result = await dispatcher.dispatch(
      { id: '4', name: 'list_files', input: { directory: 'src/dir4' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result.text).toContain('[BUDGET]');
    expect(result.text).toContain('Glob/list limit reached');
  });
});

describe('ToolDispatcher — discovery budget (ask mode)', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('ask', true); // ask mode — no budget limits
  });

  test('does NOT block read_file after 3 calls in ask mode (no budget in non-code modes)', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await dispatcher.dispatch(
        { id: `${i}`, name: 'read_file', input: { path: `src/file${i}.ts` } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
      expect(result.text).not.toContain('[BUDGET]');
    }
  });
});
