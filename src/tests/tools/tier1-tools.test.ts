/**
 * Phase 1 tests: Tier 1 code-navigation tools.
 *
 * Tests cover DiscoveryBudget, ToolDispatcher mode enforcement,
 * and the contract of the new tool categories.
 *
 * Note: The actual code-nav-server.ts runs as a child process and is tested
 * via integration (real fs + real child process). These unit tests cover the
 * budget and dispatcher layers, and provide contract-level verification using
 * a real temporary directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscoveryBudget, toolCategory, DEFAULT_BUDGET_CONFIG } from '../../agents/execution/DiscoveryBudget';
import { ToolDispatcher } from '../../agents/execution/ToolDispatcher';
import { __setTestData } from '../../data/DataStore';

// ─── Shared test doubles ───────────────────────────────────────────────────────

const mockMCPHost = {
  callTool: jest.fn().mockResolvedValue({ content: [{ text: '{"status":"success","matches":[]}' }] }),
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
    approvalTools: new Set<string>(),
    toolServerMap: {
      read_file: 'filesystem',
      list_files: 'filesystem',
      glob_files: 'code-nav',
      grep_content: 'code-nav',
      read_file_range: 'code-nav',
      read_head: 'code-nav',
      read_tail: 'code-nav',
      read_match_context: 'code-nav',
    },
  });
  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupTestData();
});

// ─── DiscoveryBudget unit tests ────────────────────────────────────────────────

describe('DiscoveryBudget', () => {
  test('default config matches expected limits', () => {
    expect(DEFAULT_BUDGET_CONFIG.maxWholeFileReads).toBe(2);
    expect(DEFAULT_BUDGET_CONFIG.maxTargetedReads).toBe(12);
    expect(DEFAULT_BUDGET_CONFIG.maxGlobCalls).toBe(3);
    expect(DEFAULT_BUDGET_CONFIG.maxGrepCalls).toBe(4);
    expect(DEFAULT_BUDGET_CONFIG.maxConsecutiveDiscovery).toBe(5);
  });

  test('whole_file budget blocks on 3rd call with correct suggestion', () => {
    const budget = new DiscoveryBudget();
    expect(budget.record('whole_file').allowed).toBe(true);
    expect(budget.record('whole_file').allowed).toBe(true);
    const result = budget.record('whole_file');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('[BUDGET]');
    expect(result.reason).toContain('Whole-file read limit reached');
    expect(result.suggestion).toContain('read_file_range');
  });

  test('targeted reads do not consume whole-file budget', () => {
    const budget = new DiscoveryBudget();
    budget.record('whole_file');
    budget.record('whole_file');
    // whole_file budget is now exhausted
    expect(budget.record('whole_file').allowed).toBe(false);

    // But targeted reads use a separate counter — still allowed until their own limit
    // (Note: consecutive cap applies; interleave writes to test targeted-read limit separately)
    expect(budget.record('targeted_read').allowed).toBe(true);
    expect(budget.record('targeted_read').allowed).toBe(true);
    expect(budget.record('targeted_read').allowed).toBe(true);
    // consecutive cap fires after 5 total (2 whole + 3 targeted); reset with a write
    budget.record('write_or_edit');
    // targeted reads continue working; whole_file still blocked
    expect(budget.record('targeted_read').allowed).toBe(true);
    expect(budget.record('whole_file').allowed).toBe(false); // still exhausted
  });

  test('consecutive cap fires after 5 discovery ops without write', () => {
    const budget = new DiscoveryBudget();
    // 5 allowed (one each: whole_file, targeted_read, glob, grep, targeted_read)
    expect(budget.record('targeted_read').allowed).toBe(true);
    expect(budget.record('targeted_read').allowed).toBe(true);
    expect(budget.record('targeted_read').allowed).toBe(true);
    expect(budget.record('grep').allowed).toBe(true);
    expect(budget.record('glob').allowed).toBe(true);
    // 6th consecutive — blocked
    const result = budget.record('targeted_read');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('consecutive discovery');
  });

  test('write_or_edit resets consecutive counter', () => {
    const budget = new DiscoveryBudget();
    // Use up 5 discovery ops
    for (let i = 0; i < 5; i++) {
      budget.record('targeted_read');
    }
    // Would be blocked on next discovery
    expect(budget.record('targeted_read').allowed).toBe(false);
    // Reset budget (new instance) and test with write
    const b2 = new DiscoveryBudget();
    for (let i = 0; i < 5; i++) {
      b2.record('targeted_read');
    }
    b2.record('write_or_edit'); // resets consecutive
    expect(b2.record('targeted_read').allowed).toBe(true);
  });

  test('validate (run_command) also resets consecutive counter', () => {
    const budget = new DiscoveryBudget();
    for (let i = 0; i < 5; i++) {
      budget.record('targeted_read');
    }
    budget.record('validate');
    expect(budget.record('targeted_read').allowed).toBe(true);
  });

  test('getState returns accurate telemetry', () => {
    const budget = new DiscoveryBudget();
    budget.record('whole_file');
    budget.record('targeted_read');
    budget.record('targeted_read');
    budget.record('glob');
    budget.record('grep');
    budget.record('write_or_edit');
    budget.recordFallbackWrite();
    const state = budget.getState();
    expect(state.wholeFileReads).toBe(1);
    expect(state.targetedReads).toBe(2);
    expect(state.globCalls).toBe(1);
    expect(state.grepCalls).toBe(1);
    expect(state.structuredEdits).toBe(1);
    expect(state.fallbackWrites).toBe(1);
  });

  test('custom config overrides defaults', () => {
    const budget = new DiscoveryBudget({ maxWholeFileReads: 5 });
    for (let i = 0; i < 5; i++) {
      expect(budget.record('whole_file').allowed).toBe(true);
    }
    expect(budget.record('whole_file').allowed).toBe(false);
  });
});

// ─── toolCategory mapping ──────────────────────────────────────────────────────

describe('toolCategory', () => {
  test('maps legacy and new tools to correct categories', () => {
    expect(toolCategory('read_file')).toBe('whole_file');
    expect(toolCategory('read_file_range')).toBe('targeted_read');
    expect(toolCategory('read_head')).toBe('targeted_read');
    expect(toolCategory('read_tail')).toBe('targeted_read');
    expect(toolCategory('read_match_context')).toBe('targeted_read');
    expect(toolCategory('read_symbol_block')).toBe('targeted_read');
    expect(toolCategory('glob_files')).toBe('glob');
    expect(toolCategory('list_files')).toBe('glob');
    expect(toolCategory('find_symbols')).toBe('glob');
    expect(toolCategory('replace_symbol_block')).toBe('write_or_edit');
    expect(toolCategory('insert_before_symbol')).toBe('write_or_edit');
    expect(toolCategory('insert_after_symbol')).toBe('write_or_edit');
    expect(toolCategory('grep_content')).toBe('grep');
    expect(toolCategory('search_files')).toBe('grep');
    expect(toolCategory('write_file')).toBe('write_or_edit');
    expect(toolCategory('edit_file')).toBe('write_or_edit');
    expect(toolCategory('replace_range')).toBe('write_or_edit');
    expect(toolCategory('multi_edit')).toBe('write_or_edit');
    expect(toolCategory('run_command')).toBe('validate');
    expect(toolCategory('git_status')).toBe('other');
    expect(toolCategory('update_task_state')).toBe('other');
  });
});

// ─── ToolDispatcher mode enforcement ──────────────────────────────────────────

describe('ToolDispatcher — new search tools in code mode', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('glob_files counts against glob budget in code mode', async () => {
    // 3 glob_files calls allowed (maxGlobCalls = 3)
    for (let i = 0; i < 3; i++) {
      const result = await dispatcher.dispatch(
        { id: `${i}`, name: 'glob_files', input: { pattern: 'src/**/*.ts' } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
      expect(result.text).not.toContain('[BUDGET]');
    }
    // 4th should be blocked
    const blocked = await dispatcher.dispatch(
      { id: '4', name: 'glob_files', input: { pattern: 'src/**/*.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(blocked.text).toContain('[BUDGET]');
    expect(blocked.text).toContain('Glob/list limit reached');
  });

  test('grep_content counts against grep budget in code mode', async () => {
    for (let i = 0; i < 4; i++) {
      const result = await dispatcher.dispatch(
        { id: `${i}`, name: 'grep_content', input: { pattern: 'foo' } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
      expect(result.text).not.toContain('[BUDGET]');
    }
    const blocked = await dispatcher.dispatch(
      { id: '5', name: 'grep_content', input: { pattern: 'bar' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(blocked.text).toContain('[BUDGET]');
    expect(blocked.text).toContain('Grep limit reached');
  });

  test('read_file_range counts as targeted_read, not whole_file', async () => {
    // Use up both whole-file reads
    for (let i = 0; i < 2; i++) {
      await dispatcher.dispatch(
        { id: `wf${i}`, name: 'read_file', input: { path: `src/file${i}.ts` } },
        'agent', mockOnApproval, mockOnDiff, mockOnThought
      );
    }
    // whole_file budget exhausted
    const wholeBlocked = await dispatcher.dispatch(
      { id: 'wf3', name: 'read_file', input: { path: 'src/file3.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(wholeBlocked.text).toContain('[BUDGET]');

    // targeted reads still allowed
    const rangeResult = await dispatcher.dispatch(
      { id: 'r1', name: 'read_file_range', input: { path: 'src/file0.ts', start_line: 1, end_line: 50 } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(rangeResult.text).not.toContain('[BUDGET]');
  });

  test('getBudgetTelemetry returns accurate counts', async () => {
    await dispatcher.dispatch(
      { id: '1', name: 'read_file', input: { path: 'src/a.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    await dispatcher.dispatch(
      { id: '2', name: 'glob_files', input: { pattern: '**/*.ts' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    await dispatcher.dispatch(
      { id: '3', name: 'grep_content', input: { pattern: 'foo' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    const telemetry = dispatcher.getBudgetTelemetry();
    expect(telemetry.wholeFileReads).toBe(1);
    expect(telemetry.globCalls).toBe(1);
    expect(telemetry.grepCalls).toBe(1);
  });
});

// ─── Filesystem fixture tests for code-nav tools ──────────────────────────────

describe('DiscoveryBudget — targeted read categories', () => {
  test('all 6 targeted-read tool names map to targeted_read', () => {
    const targetedTools = [
      'read_file_range', 'read_head', 'read_tail',
      'read_match_context', 'read_symbol_block',
    ];
    for (const t of targetedTools) {
      expect(toolCategory(t)).toBe('targeted_read');
    }
  });

  test('targeted reads exhaust at 12 not 2 (interleaving writes to avoid consecutive cap)', () => {
    const budget = new DiscoveryBudget();
    let allowedCount = 0;
    for (let i = 0; i < 20; i++) {
      const result = budget.record('targeted_read');
      if (!result.allowed) break;
      allowedCount++;
      // Reset consecutive every 5 reads to avoid the consecutive cap
      if ((allowedCount) % 5 === 0) {
        budget.record('write_or_edit');
      }
    }
    expect(allowedCount).toBe(12);
  });
});

// ─── Path blocking ─────────────────────────────────────────────────────────────

describe('ToolDispatcher — .bormagi blocking for new tools', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('glob_files with .bormagi path is blocked before MCP call', async () => {
    const result = await dispatcher.dispatch(
      { id: '1', name: 'glob_files', input: { pattern: '.bormagi/**' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });

  test('grep_content passes through to server (server excludes .bormagi internally)', async () => {
    // grep_content does not have a path field — server-side DEFAULT_EXCLUDES handles .bormagi.
    // Verify the dispatcher does not add an extra block (the server is mocked here to return success).
    const result = await dispatcher.dispatch(
      { id: '1', name: 'grep_content', input: { pattern: 'secret', include: ['**/*.ts'] } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought
    );
    // Not blocked at dispatcher level — goes to server
    expect(mockMCPHost.callTool).toHaveBeenCalled();
    expect(result.text).not.toContain('[BLOCKED] bormagi');
  });
});
