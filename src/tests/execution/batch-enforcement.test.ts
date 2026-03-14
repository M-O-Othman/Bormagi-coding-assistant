/**
 * Regression tests for Phase 4: batch enforcement.
 * Verifies that BatchEnforcer rejects off-batch writes and tracks batch progress.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BatchEnforcer } from '../../agents/execution/BatchEnforcer';
import type { ExecutionStateData } from '../../agents/ExecutionStateManager';

function makeState(batch: string[], completed: string[] = []): ExecutionStateData {
  return {
    version: 2,
    agentId: 'test',
    objective: 'test',
    mode: 'code',
    workspaceRoot: '/ws',
    resolvedInputs: [],
    artifactsCreated: completed,
    completedSteps: [],
    nextActions: [],
    blockers: [],
    techStack: {},
    iterationsUsed: 0,
    plannedFileBatch: batch,
    completedBatchFiles: completed,
    updatedAt: new Date().toISOString(),
    executedTools: [],
  } as any;
}

describe('BatchEnforcer — greenfield workspace', () => {
  let tmpDir: string;
  let enforcer: BatchEnforcer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bormagi-batch-'));
    enforcer = new BatchEnforcer(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('detects greenfield when no package.json or src/', async () => {
    const type = await enforcer.detectWorkspaceType();
    expect(type).toBe('greenfield');
  });

  test('rejects write when no batch declared in greenfield', async () => {
    const state = makeState([], []);
    const result = enforcer.checkWritePermission('src/index.ts', state, '[BATCH VIOLATION]', 'greenfield');
    expect(result).toContain('[BATCH VIOLATION]');
  });

  test('allows write when path is in declared batch', async () => {
    const state = makeState(['src/index.ts', 'src/utils.ts']);
    const result = enforcer.checkWritePermission('src/index.ts', state, '[BATCH VIOLATION]', 'greenfield');
    expect(result).toBeNull();
  });

  test('rejects off-batch writes', async () => {
    const state = makeState(['src/index.ts']);
    const result = enforcer.checkWritePermission('src/other.ts', state, '[BATCH VIOLATION]', 'greenfield');
    expect(result).toContain('[BATCH VIOLATION]');
  });
});

describe('BatchEnforcer — mature workspace', () => {
  let tmpDir: string;
  let enforcer: BatchEnforcer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bormagi-batch-mature-'));
    // Create package.json with 5+ source files to qualify as mature
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(srcDir, `file${i}.ts`), '');
    }
    enforcer = new BatchEnforcer(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('detects mature when package.json + 5+ source files', async () => {
    const type = await enforcer.detectWorkspaceType();
    expect(type).toBe('mature');
  });

  test('allows any write in mature workspace regardless of batch', async () => {
    const state = makeState(['src/index.ts']); // batch declared for other files
    const result = enforcer.checkWritePermission('src/unrelated.ts', state, '[BATCH VIOLATION]', 'mature');
    expect(result).toBeNull();
  });
});

describe('BatchEnforcer.getBatchProgress', () => {
  let enforcer: BatchEnforcer;

  beforeEach(() => {
    enforcer = new BatchEnforcer('/ws');
  });

  test('returns correct progress when partial batch completed', () => {
    const state = makeState(['a.ts', 'b.ts', 'c.ts'], ['a.ts']);
    const progress = enforcer.getBatchProgress(state);
    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(1);
    expect(progress.remaining).toEqual(['b.ts', 'c.ts']);
  });

  test('returns zero progress when no batch declared', () => {
    const state = makeState([]);
    const progress = enforcer.getBatchProgress(state);
    expect(progress.total).toBe(0);
    expect(progress.completed).toBe(0);
    expect(progress.remaining).toEqual([]);
  });
});
