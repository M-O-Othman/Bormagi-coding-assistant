/**
 * Phase 3 tests: symbol tools (find_symbols, read_symbol_block, replace_symbol_block,
 * insert_before_symbol, insert_after_symbol).
 *
 * Tests run against real fixture files in src/tests/fixtures/.
 * The symbol parsing engine is exercised directly via the exported functions from
 * code-nav-server.ts — which are also the functions the MCP server calls.
 *
 * We re-export the internals under test from a thin wrapper to keep the server file
 * self-contained. Since the server file is not designed for direct import in tests
 * (it starts readline on import), we test the logic indirectly through a mini-server
 * harness — or, more practically, by copying test-relevant functions here.
 *
 * Strategy: We test the ToolDispatcher routing for symbol tools (similar to edit-tools.test.ts),
 * and test the actual symbol parsing by spawning code-nav-server.js and calling it via JSON-RPC
 * in a sub-process.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { toolCategory } from '../../agents/execution/DiscoveryBudget';
import { ToolDispatcher } from '../../agents/execution/ToolDispatcher';
import { __setTestData } from '../../data/DataStore';

// ─── Shared test doubles ──────────────────────────────────────────────────────

const mockMCPHost = {
  callTool: jest.fn().mockResolvedValue({ content: [{ text: '{"status":"success","payload":{"matches":[]}}' }] }),
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
    approvalTools: new Set<string>([
      'replace_range', 'multi_edit',
      'replace_symbol_block', 'insert_before_symbol', 'insert_after_symbol',
    ]),
    toolServerMap: {
      read_file: 'filesystem',
      list_files: 'filesystem',
      find_symbols: 'code-nav',
      read_symbol_block: 'code-nav',
      replace_symbol_block: 'code-nav',
      insert_before_symbol: 'code-nav',
      insert_after_symbol: 'code-nav',
    },
  });
  const vscode = require('vscode');
  vscode.__setConfig('bormagi', { executionEngineV2: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupTestData();
});

// ─── toolCategory mapping — symbol tools ──────────────────────────────────────

describe('toolCategory — symbol tools', () => {
  test('find_symbols maps to glob', () => {
    expect(toolCategory('find_symbols')).toBe('glob');
  });

  test('read_symbol_block maps to targeted_read', () => {
    expect(toolCategory('read_symbol_block')).toBe('targeted_read');
  });

  test('replace_symbol_block, insert_before/after map to write_or_edit', () => {
    expect(toolCategory('replace_symbol_block')).toBe('write_or_edit');
    expect(toolCategory('insert_before_symbol')).toBe('write_or_edit');
    expect(toolCategory('insert_after_symbol')).toBe('write_or_edit');
  });
});

// ─── ToolDispatcher routing ───────────────────────────────────────────────────

describe('ToolDispatcher — symbol tools route to code-nav', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('find_symbols routes to code-nav', async () => {
    await dispatcher.dispatch(
      { id: '1', name: 'find_symbols', input: { query: 'Calculator' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'find_symbols' }),
    );
  });

  test('read_symbol_block routes to code-nav', async () => {
    await dispatcher.dispatch(
      { id: '2', name: 'read_symbol_block', input: { path: 'src/a.ts', symbol: 'Calculator' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'read_symbol_block' }),
    );
  });

  test('replace_symbol_block requires approval and routes to code-nav', async () => {
    await dispatcher.dispatch(
      { id: '3', name: 'replace_symbol_block', input: { path: 'src/a.ts', symbol: 'foo', replacement: 'function foo() {}' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockOnApproval).toHaveBeenCalled();
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'replace_symbol_block' }),
    );
  });

  test('insert_before_symbol routes to code-nav', async () => {
    await dispatcher.dispatch(
      { id: '4', name: 'insert_before_symbol', input: { path: 'src/a.ts', symbol: 'foo', content: '// comment' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'insert_before_symbol' }),
    );
  });

  test('insert_after_symbol routes to code-nav', async () => {
    await dispatcher.dispatch(
      { id: '5', name: 'insert_after_symbol', input: { path: 'src/a.ts', symbol: 'foo', content: '// end' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(mockMCPHost.callTool).toHaveBeenCalledWith(
      'code-nav',
      expect.objectContaining({ name: 'insert_after_symbol' }),
    );
  });
});

// ─── .bormagi blocking for symbol tools ──────────────────────────────────────

describe('ToolDispatcher — .bormagi blocking for symbol tools', () => {
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dispatcher = new ToolDispatcher(mockMCPHost, mockUndoManager, mockAuditLogger, '/workspace');
    dispatcher.resetGuardState('code', true);
  });

  test('read_symbol_block with .bormagi path is blocked', async () => {
    const result = await dispatcher.dispatch(
      { id: '1', name: 'read_symbol_block', input: { path: '.bormagi/state.json', symbol: 'anything' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });

  test('replace_symbol_block with .bormagi path is blocked', async () => {
    const result = await dispatcher.dispatch(
      { id: '2', name: 'replace_symbol_block', input: { path: '.bormagi/config.json', symbol: 'foo', replacement: 'bad' } },
      'agent', mockOnApproval, mockOnDiff, mockOnThought,
    );
    expect(result.text).toContain('[BLOCKED]');
    expect(mockMCPHost.callTool).not.toHaveBeenCalled();
  });
});

// ─── Symbol parsing — fixture-based unit tests ────────────────────────────────
//
// We test the parsing functions by spawning the compiled code-nav-server via JSON-RPC.
// The server binary is at: out/mcp-servers/code-nav-server.js (built output).
//
// If the server is not compiled yet, these tests are skipped gracefully.

const SERVER_PATH = path.resolve(__dirname, '../../..', 'dist/mcp-servers/code-nav-server.js');
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');

function callServer(workspaceRoot: string, toolName: string, toolArgs: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('node', [SERVER_PATH, workspaceRoot], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let output = '';
    let settled = false;
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    // Kill the process after 20s to prevent hanging
    const killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`Server timed out after 20s. Output so far: ${output.slice(0, 500)}`));
      }
    }, 20000);

    proc.on('close', () => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      try {
        // Server sends initialize response first, then tools/list, then result
        const lines = output.trim().split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        resolve(last);
      } catch (e) {
        reject(new Error(`Server output parse error: ${e}\nOutput: ${output}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // Initialize
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    // Call tool
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
    }) + '\n');
    proc.stdin.end();
  });
}

const serverExists = fs.existsSync(SERVER_PATH);

describe('Symbol parsing — fixture-based (integration, requires compiled server)', () => {
  (serverExists ? test : test.skip)('find_symbols — finds Calculator class in fixture', async () => {
    const response = await callServer(FIXTURE_DIR, 'find_symbols', {
      query: 'Calculator',
      symbol_kind: 'class',
      include: ['**/*.ts'],
    });
    const result = (response as any).result;
    const content = JSON.parse(result.content[0].text);
    expect(content.status).toBe('success');
    expect(content.payload.matches.length).toBeGreaterThan(0);
    expect(content.payload.matches[0].symbol).toBe('Calculator');
    expect(content.payload.matches[0].symbolKind).toBe('class');
  });

  (serverExists ? test : test.skip)('find_symbols — finds greetUser function by name', async () => {
    const response = await callServer(FIXTURE_DIR, 'find_symbols', {
      query: 'greetUser',
      symbol_kind: 'any',
      include: ['**/*.ts'],
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');
    const match = content.payload.matches.find((m: any) => m.symbol === 'greetUser');
    expect(match).toBeDefined();
    expect(match.symbolKind).toBe('function');
  });

  (serverExists ? test : test.skip)('read_symbol_block — returns correct lines for Calculator', async () => {
    const response = await callServer(FIXTURE_DIR, 'read_symbol_block', {
      path: 'sample-module.ts',
      symbol: 'Calculator',
      symbol_kind: 'class',
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');
    expect(content.payload.location.symbol).toBe('Calculator');
    expect(content.payload.content.length).toBeGreaterThan(3);
    // First line should contain 'class Calculator'
    expect(content.payload.content[0].text).toContain('Calculator');
  });

  (serverExists ? test : test.skip)('read_symbol_block — unknown symbol returns error', async () => {
    const response = await callServer(FIXTURE_DIR, 'read_symbol_block', {
      path: 'sample-module.ts',
      symbol: 'NonExistentSymbol',
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('error');
    expect(content.summary).toContain('NonExistentSymbol');
  });

  (serverExists ? test : test.skip)('replace_symbol_block — preview_only returns diff without changing file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-test-'));
    const fixture = path.join(FIXTURE_DIR, 'sample-module.ts');
    const tmpFile = path.join(tmpDir, 'sample-module.ts');
    fs.copyFileSync(fixture, tmpFile);
    const origContent = fs.readFileSync(tmpFile, 'utf8');

    const response = await callServer(tmpDir, 'replace_symbol_block', {
      path: 'sample-module.ts',
      symbol: 'greetUser',
      replacement: 'export function greetUser(name: string): string { return `Hi ${name}`; }',
      preview_only: true,
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');
    expect(content.summary).toContain('[PREVIEW]');
    // File must be unchanged
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe(origContent);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  (serverExists ? test : test.skip)('replace_symbol_block — applies replacement, other symbols intact', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-test-'));
    const fixture = path.join(FIXTURE_DIR, 'sample-module.ts');
    const tmpFile = path.join(tmpDir, 'sample-module.ts');
    fs.copyFileSync(fixture, tmpFile);

    const response = await callServer(tmpDir, 'replace_symbol_block', {
      path: 'sample-module.ts',
      symbol: 'greetUser',
      replacement: 'export function greetUser(name: string): string { return `Hi ${name}!`; }',
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');

    const newContent = fs.readFileSync(tmpFile, 'utf8');
    expect(newContent).toContain('Hi ${name}!');
    expect(newContent).toContain('Calculator'); // other symbol still present
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  (serverExists ? test : test.skip)('insert_before_symbol — inserts content before target', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-test-'));
    fs.copyFileSync(path.join(FIXTURE_DIR, 'sample-module.ts'), path.join(tmpDir, 'sample-module.ts'));

    const response = await callServer(tmpDir, 'insert_before_symbol', {
      path: 'sample-module.ts',
      symbol: 'greetUser',
      content: '// inserted before greetUser',
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');
    const newContent = fs.readFileSync(path.join(tmpDir, 'sample-module.ts'), 'utf8');
    const insertIdx = newContent.indexOf('// inserted before greetUser');
    const fnIdx = newContent.indexOf('export function greetUser');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeLessThan(fnIdx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  (serverExists ? test : test.skip)('insert_after_symbol — inserts content after target', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-test-'));
    fs.copyFileSync(path.join(FIXTURE_DIR, 'sample-module.ts'), path.join(tmpDir, 'sample-module.ts'));

    const response = await callServer(tmpDir, 'insert_after_symbol', {
      path: 'sample-module.ts',
      symbol: 'greetUser',
      content: '// inserted after greetUser',
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');
    const newContent = fs.readFileSync(path.join(tmpDir, 'sample-module.ts'), 'utf8');
    const insertIdx = newContent.indexOf('// inserted after greetUser');
    const fnIdx = newContent.indexOf('export function greetUser');
    expect(fnIdx).toBeLessThan(insertIdx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  (serverExists ? test : test.skip)('find_symbols — regex fallback for .py file finds my_function', async () => {
    const response = await callServer(FIXTURE_DIR, 'find_symbols', {
      query: 'my_function',
      symbol_kind: 'function',
      include: ['**/*.py'],
    });
    const content = JSON.parse(((response as any).result.content[0].text));
    expect(content.status).toBe('success');
    const match = content.payload.matches.find((m: any) => m.symbol === 'my_function');
    expect(match).toBeDefined();
    expect(match.symbolKind).toBe('function');
  });
});
