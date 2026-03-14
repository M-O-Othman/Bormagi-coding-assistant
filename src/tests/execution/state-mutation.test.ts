/**
 * Regression tests for Phase 1: authoritative state mutations.
 * Verifies that speculative assistant text does NOT mutate state,
 * and that iterations increment only on successful tool execution.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ExecutionStateManager } from '../../agents/ExecutionStateManager';

describe('ExecutionStateManager — authoritative mutations', () => {
  let tmpDir: string;
  let mgr: ExecutionStateManager;
  const agentId = 'test-agent';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bormagi-state-'));
    mgr = new ExecutionStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('createFresh produces version 2 state with empty fields', () => {
    const state = mgr.createFresh(agentId, 'build a website', 'code');
    expect(state.version).toBe(2);
    expect(state.iterationsUsed).toBe(0);
    expect(state.executedTools).toEqual([]);
    expect(state.artifactsCreated).toEqual([]);
  });

  test('markToolExecuted increments iterationsUsed', () => {
    const state = mgr.createFresh(agentId, 'test', 'code');
    mgr.markToolExecuted(state, 'read_file', 'src/main.ts', 'ok');
    expect(state.iterationsUsed).toBe(1);
    expect(state.executedTools).toHaveLength(1);
    expect(state.lastExecutedTool).toBe('read_file');
  });

  test('markFileRead records path in resolvedInputs', () => {
    const state = mgr.createFresh(agentId, 'test', 'code');
    mgr.markFileRead(state, 'src/foo.ts');
    expect(state.resolvedInputs).toContain('src/foo.ts');
  });

  test('markFileWritten adds to artifactsCreated and completedBatchFiles', () => {
    const state = mgr.createFresh(agentId, 'test', 'code');
    state.plannedFileBatch = ['src/foo.ts'];
    mgr.markFileWritten(state, 'src/foo.ts');
    expect(state.artifactsCreated).toContain('src/foo.ts');
    expect(state.completedBatchFiles).toContain('src/foo.ts');
  });

  test('canReadFile returns false after file is read (reread prevention)', () => {
    const state = mgr.createFresh(agentId, 'test', 'code');
    mgr.markFileRead(state, 'src/foo.ts');
    expect(mgr.canReadFile(state, 'src/foo.ts')).toBe(false);
  });

  test('canReadFile returns true after file has been written since last read', () => {
    const state = mgr.createFresh(agentId, 'test', 'code');
    mgr.markFileRead(state, 'src/foo.ts');
    mgr.markFileWritten(state, 'src/foo.ts');
    // After write, re-reading should be allowed
    expect(mgr.canReadFile(state, 'src/foo.ts')).toBe(true);
  });

  test('state persists and loads correctly across save/load cycle', async () => {
    const state = mgr.createFresh(agentId, 'build a website', 'code');
    mgr.markToolExecuted(state, 'write_file', 'src/index.ts', 'written');
    await mgr.save(agentId, state);

    const loaded = await mgr.load(agentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.iterationsUsed).toBe(1);
    expect(loaded!.lastExecutedTool).toBe('write_file');
  });
});
