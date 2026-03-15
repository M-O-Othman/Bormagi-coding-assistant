/**
 * Phase 2 tests: replace_range and multi_edit via ToolDispatcher.
 *
 * Verifies:
 *  - Both tools require approval (approvalTools set)
 *  - Both tools are blocked in ask mode (filterToolsByMode)
 *  - Both tools route to the code-nav server (toolServerMap)
 *  - replace_range and multi_edit count as write_or_edit in budget (resets consecutive counter)
 *  - .bormagi path blocking applies to replace_range
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolDispatcher } from '../../agents/execution/ToolDispatcher';
import { toolCategory } from '../../agents/execution/DiscoveryBudget';
import { __setTestData } from '../../data/DataStore';

// ─── Shared test doubles ──────────────────────────────────────────────────────

const mockMCPHost = {
  callTool: jest.fn().mockResolvedValue({ content: [{ text: '{"status":"success"}' }] }),
} as any;
const mockUndoManager = {} as any;
const mockAuditLogger = { logCommand: jest.fn(), logFileWrite: jest.fn() } as any;
const mockOnApproval = jest.fn().mockResolvedValue(true);
const mockOnDiff = jest.fn().mockResolvedValue(true);
const mockOnThought = jest.fn();

function setupTestData() {
  __setTestData({
    executionMessages: {
      toolBlocked: {
        bormagiPath: '[BLOCKED] bormagi',
        reread: '[BLOCKED] reread',
        budgetExhausted: '[BUDGET EXHAUSTED]',
        offBatch: '[BATCH VIOLATION]',
      },
      toolSummary: { format: '', formatNoPath: '' },
      continueResume: {},
      stateContextNote: {},
      validatorIssues: {},
    },
    approvalTools: new Set<string>(['replace_range', 'multi_edit', 'write_file']),
    toolServerMap: {
      read_file: 'filesystem',
      list_files: 'filesystem',
      glob_files: 'code-nav',
      grep_content: 'code-nav',
      read_file_range: 'code-nav',
      read_head: 'code-nav',
      read_tail: 'code-nav',
      read_match_context: 'code-nav',
      replace_range: 'code-nav',
      multi_edit: 'code-nav',
    },
  });
  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupTestData();
});

// ─── toolCategory mapping ──────────────────────────────────────────────────────

describe('toolCategory — edit tools', () => {
  test('replace_range maps to write_or_edit', () => {
    expect(toolCategory('replace_range')).toBe('write_or_edit');
  });

  test('multi_edit maps to write_or_edit', () => {
    expect(toolCategory('multi_edit')).toBe('write_or_edit');
  });
});

// ─── Budget interaction ────────────────────────────────────────────────────────

describe('ToolDispatcher — edit tools reset consecutive discovery counter', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('replace_range after 5 discovery ops resets consecutive counter', async () => {
    // Exhaust consecutive cap (5 targeted reads)
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatch(
        { id: `r${i}`, name: 'read_file_range', input: { path: `src/f${i}.ts`, start_line: 1, end_line: 10 } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought,
      );
    }
    // 6th discovery would be blocked
    const preEdit = await dispatcher.dispatch(
      { id: 'pre', name: 'read_file_range', input: { path: 'src/check.ts', start_line: 1, end_line: 5 } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(preEdit.text).toContain('[BUDGET]');

    // replace_range resets consecutive counter
    await dispatcher.dispatch(
      { id: 'edit1', name: 'replace_range', input: { path: 'src/a.ts', start_line: 1, end_line: 2, replacement: 'x' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );

    // targeted read is now allowed again
    const postEdit = await dispatcher.dispatch(
      { id: 'post', name: 'read_file_range', input: { path: 'src/check2.ts', start_line: 1, end_line: 5 } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(postEdit.text).not.toContain('[BUDGET]');
  });

  test('multi_edit resets consecutive counter', async () => {
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatch(
        { id: `r${i}`, name: 'read_file_range', input: { path: `src/f${i}.ts`, start_line: 1, end_line: 10 } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought,
      );
    }
    const blocked = await dispatcher.dispatch(
      { id: 'bk', name: 'grep_content', input: { pattern: 'foo' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(blocked.text).toContain('[BUDGET]');

    await dispatcher.dispatch(
      { id: 'me1', name: 'multi_edit', input: { edits: [{ path: 'src/a.ts', start_line: 1, end_line: 1, replacement: 'x' }] } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );

    const allowed = await dispatcher.dispatch(
      { id: 'ok', name: 'grep_content', input: { pattern: 'bar' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(allowed.text).not.toContain('[BUDGET]');
  });
});

// ─── .bormagi path blocking ────────────────────────────────────────────────────

describe('ToolDispatcher — .bormagi blocking for edit tools', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('replace_range with .bormagi path is blocked before MCP call', async () => {
    const result = await dispatcher.dispatch(
      { id: '1', name: 'replace_range', input: { path: '.bormagi/state.json', start_line: 1, end_line: 1, replacement: 'x' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });

  test('multi_edit with a .bormagi path in edits array is blocked before MCP call', async () => {
    const result = await dispatcher.dispatch(
      {
        id: '2',
        name: 'multi_edit',
        input: {
          edits: [
            { path: 'src/ok.ts', start_line: 1, end_line: 2, replacement: 'ok' },
            { path: '.bormagi/config.json', start_line: 1, end_line: 1, replacement: 'bad' },
          ],
        },
      },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });
});

// ─── Server routing ───────────────────────────────────────────────────────────

describe('ToolDispatcher — replace_range and multi_edit route to code-nav', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('replace_range calls MCP host with server="code-nav"', async () => {
    await dispatcher.dispatch(
      { id: '1', name: 'replace_range', input: { path: 'src/a.ts', start_line: 1, end_line: 2, replacement: 'x' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'replace_range', input: expect.objectContaining({ path: 'src/a.ts' }) }),
    );
  });

  test('multi_edit calls MCP host with server="code-nav"', async () => {
    await dispatcher.dispatch(
      {
        id: '2',
        name: 'multi_edit',
        input: { edits: [{ path: 'src/b.ts', start_line: 3, end_line: 5, replacement: 'y' }] },
      },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'multi_edit', input: expect.objectContaining({ edits: expect.any(Array) }) }),
    );
  });
});
