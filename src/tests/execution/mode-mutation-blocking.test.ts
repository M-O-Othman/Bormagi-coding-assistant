/**
 * Phase 6.1 — ToolDispatcher blocks mutation tools in ask/plan modes.
 */
import { ToolDispatcher } from '../../agents/execution/ToolDispatcher';
import { __setTestData } from '../../data/DataStore';

const mockMCPHost = {
  callTool: jest.fn().mockResolvedValue({ content: [{ text: '{"status":"success"}' }] }),
} as any;
const mockUndoManager = {} as any;
const mockAuditLogger = { logCommand: jest.fn(), logFileWrite: jest.fn() } as any;
const mockOnApproval = jest.fn().mockResolvedValue(false); // reject approval so no actual writes
const mockOnDiff = jest.fn().mockResolvedValue(false);
const mockOnThought = jest.fn();

function setupTestData() {
  __setTestData({
    executionMessages: {
      toolBlocked: {
        bormagiPath: '[BLOCKED] bormagi',
        reread: '[BLOCKED] reread',
        budgetExhausted: '[BUDGET EXHAUSTED]',
        offBatch: '[BATCH VIOLATION]',
        modeDisallowsMutation: "[BLOCKED] Mode '{mode}' does not permit file mutations. Switch to Code mode to make changes.",
      },
      toolSummary: { format: '', formatNoPath: '' },
      continueResume: {},
      stateContextNote: {},
      validatorIssues: {},
    },
    approvalTools: new Set<string>(['write_file', 'edit_file']),
    toolServerMap: {
      read_file: 'filesystem',
      write_file: 'filesystem',
      edit_file: 'filesystem',
    },
  });
  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
}

describe('ToolDispatcher — mutation tool blocking in ask/plan modes', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    setupTestData();
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/tmp/ws');
  });

  const mutationTools = ['write_file', 'edit_file'];

  for (const toolName of mutationTools) {
    test(`${toolName} in 'ask' mode returns BLOCKED message`, async () => {
      dispatcher.resetGuardState('ask', true);
      const result = await dispatcher.dispatch(
        { id: 'test-1', name: toolName, input: { path: 'src/test.ts', content: 'hello' } },
        'test-agent',
        mockOnApproval,
        mockOnDiff,
        mockOnThought,
      );
      expect(result).toMatch(/BLOCKED/i);
      expect(result).toMatch(/ask/i);
    });

    test(`${toolName} in 'plan' mode returns BLOCKED message`, async () => {
      dispatcher.resetGuardState('plan', true);
      const result = await dispatcher.dispatch(
        { id: 'test-2', name: toolName, input: { path: 'src/test.ts', content: 'hello' } },
        'test-agent',
        mockOnApproval,
        mockOnDiff,
        mockOnThought,
      );
      expect(result).toMatch(/BLOCKED/i);
      expect(result).toMatch(/plan/i);
    });
  }

  test('read_file in ask mode is NOT blocked by mode guard', async () => {
    dispatcher.resetGuardState('ask', true);
    const result = await dispatcher.dispatch(
      { id: 'test-4', name: 'read_file', input: { path: 'nonexistent.ts' } },
      'test-agent',
      mockOnApproval,
      mockOnDiff,
      mockOnThought,
    );
    // Not the mode-block message
    expect(result).not.toMatch(/Mode .* does not permit/i);
  });

  test('write_file in code mode is NOT blocked by mode guard (V2 enabled)', async () => {
    dispatcher.resetGuardState('code', true);
    // approval is denied, so write won't happen, but mode guard must not fire
    const result = await dispatcher.dispatch(
      { id: 'test-5', name: 'write_file', input: { path: 'src/allowed.ts', content: 'export {};' } },
      'test-agent',
      mockOnApproval, // approval denied
      mockOnDiff,
      mockOnThought,
    );
    expect(result).not.toMatch(/Mode .* does not permit/i);
  });
});
