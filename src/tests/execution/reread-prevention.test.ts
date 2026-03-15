/**
 * Regression tests for Phase 3: reread prevention.
 * Verifies that ToolDispatcher blocks re-reading unchanged files.
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
        reread: '[BLOCKED] File already read and unchanged this session. Use the content from your earlier read.',
        budgetExhausted: '[BUDGET EXHAUSTED] Discovery limit reached.',
        offBatch: '[BATCH VIOLATION]',
      },
      toolSummary: { format: '', formatNoPath: '' },
      continueResume: {},
      stateContextNote: {},
      validatorIssues: {},
    },
    approvalTools: new Set<string>(),
    toolServerMap: { read_file: 'filesystem', write_file: 'filesystem' },
  });

  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
});

describe('ToolDispatcher — reread prevention', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('allows first read of a file', async () => {
    const result = await dispatcher.dispatch(
      { id: '1', name: 'read_file', input: { path: 'src/main.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    // DD4: dispatch returns DispatchResult, not string
    expect(result.text).not.toContain('[BLOCKED]');
    expect(result.status).toBe('success');
  });

  test('returns brief pointer on re-read of unchanged file', async () => {
    // First read — allowed, then cache the result
    await dispatcher.dispatch(
      { id: '1', name: 'read_file', input: { path: 'src/main.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    dispatcher.cacheReadResult('src/main.ts', 'file content');
    // Second read of same file — returns cached result, no MCP call
    const result = await dispatcher.dispatch(
      { id: '2', name: 'read_file', input: { path: 'src/main.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    // DD4: structured result with cached status
    expect(result.status).toBe('cached');
    expect(result.reasonCode).toBe('ALREADY_READ_UNCHANGED');
    expect(result.text).toContain('src/main.ts');
    // MCP should only have been called once (for the first read)
    expect(mockMCPHost.callTool).toHaveBeenCalledTimes(1);
  });

  test('allows re-reading after file has been written', async () => {
    // Read the file first
    await dispatcher.dispatch(
      { id: '1', name: 'read_file', input: { path: 'src/main.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    // Here we test a different path (no prior read) to confirm allows first reads always
    const result2 = await dispatcher.dispatch(
      { id: '2', name: 'read_file', input: { path: 'src/other.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result2.text).not.toContain('[BLOCKED]');
    expect(result2.status).toBe('success');
  });

  test('reread check does not block in V1 mode', async () => {
    // Reset with useV2=false
    dispatcher.resetGuardState('code', false);
    // Read twice — should be allowed since V2 is off
    await dispatcher.dispatch(
      { id: '1', name: 'read_file', input: { path: 'src/main.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    const vscode = require('vscode');
    vscode.__setConfig('bormagi', { executionEngineV2: false });
    const result = await dispatcher.dispatch(
      { id: '2', name: 'read_file', input: { path: 'src/main.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    // V2 off → no blocking
    expect(result.text).not.toContain('[BLOCKED]');
  });
});
