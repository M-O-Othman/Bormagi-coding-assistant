/**
 * Regression tests for Phase 2: .bormagi path blocking.
 * Verifies that ToolDispatcher rejects access to the internal framework directory
 * when executionEngineV2 is enabled.
 */
import { ToolDispatcher } from '../../agents/execution/ToolDispatcher';
import { __setTestData } from '../../data/DataStore';

// Minimal mocks for ToolDispatcher dependencies
const mockMCPHost = { callTool: jest.fn() } as any;
const mockUndoManager = { recordFileWrite: jest.fn() } as any;
const mockAuditLogger = { logCommand: jest.fn(), logFileWrite: jest.fn() } as any;

const mockOnApproval = jest.fn().mockResolvedValue(true);
const mockOnDiff = jest.fn().mockResolvedValue(true);
const mockOnThought = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  __setTestData({
    executionMessages: {
      toolBlocked: {
        bormagiPath: '[BLOCKED] Agent access to .bormagi/ is not permitted. This is internal framework state.',
        reread: '[BLOCKED] File already read and unchanged this session.',
        budgetExhausted: '[BUDGET EXHAUSTED] Discovery limit reached.',
        offBatch: '[BATCH VIOLATION] Path not in declared batch.',
      },
      toolSummary: { format: '', formatNoPath: '' },
      continueResume: {},
      stateContextNote: {},
      validatorIssues: {},
    },
    approvalTools: new Set<string>(),
    toolServerMap: {},
  });

  // Mock VS Code config to enable V2
  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
});

describe('ToolDispatcher .bormagi path blocking', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(
      mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace'
    );
    dispatcher.resetGuardState('code', true);
  });

  test('blocks read_file targeting .bormagi/', async () => {
    const result = await dispatcher.dispatch(
      { id: '1', name: 'read_file', input: { path: '.bormagi/exec-state-agent.json' } },
      'agent-1', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });

  test('blocks list_files targeting .bormagi/', async () => {
    const result = await dispatcher.dispatch(
      { id: '2', name: 'list_files', input: { directory: '.bormagi/' } },
      'agent-1', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result.text).toContain('[BLOCKED]');
  });

  test('blocks write_file targeting .bormagi/', async () => {
    const result = await dispatcher.dispatch(
      { id: '3', name: 'write_file', input: { path: '.bormagi/config.json', content: '{}' } },
      'agent-1', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });

  test('exempts update_task_state from .bormagi blocking', async () => {
    // update_task_state is a virtual tool — should not be blocked
    // It has no path input so the check should not fire
    const result = await dispatcher.dispatch(
      { id: '4', name: 'update_task_state', input: { completed_step: 'done' } },
      'agent-1', mockOnApproval, mockOnDiff, mockOnThought
    );
    // Should not return a blocked message (falls through to other handling)
    expect(result.text).not.toContain('[BLOCKED]');
  });
});
