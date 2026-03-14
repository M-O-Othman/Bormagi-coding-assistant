/**
 * Regression tests for Phase 1: continue/resume contract.
 * Verifies that ExecutionStateManager preserves nextActions across sessions
 * and that buildContextNote includes them correctly.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ExecutionStateManager } from '../../agents/ExecutionStateManager';

describe('ExecutionStateManager — continue/resume contract', () => {
  let tmpDir: string;
  let mgr: ExecutionStateManager;
  const agentId = 'resume-test-agent';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bormagi-resume-'));
    mgr = new ExecutionStateManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('nextActions survive save/load cycle', async () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    state.nextActions = ['implement GET /users', 'add tests'];
    await mgr.save(agentId, state);

    const loaded = await mgr.load(agentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.nextActions).toEqual(['implement GET /users', 'add tests']);
  });

  test('setNextAction updates nextActions and lastExecutedTool', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    mgr.markToolExecuted(state, 'write_file', 'src/routes.ts', 'written');
    mgr.setNextAction(state, 'write tests for routes');
    expect(state.nextActions[0]).toBe('write tests for routes');
    expect(state.lastExecutedTool).toBe('write_file');
  });

  test('buildContextNote includes nextActions', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    state.nextActions = ['write GET /users handler'];
    const note = mgr.buildContextNote(state);
    expect(note).toContain('Next pending actions');
    expect(note).toContain('write GET /users handler');
  });

  test('buildContextNote includes completedSteps', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    state.completedSteps = ['wrote models.ts', 'wrote routes.ts'];
    const note = mgr.buildContextNote(state);
    expect(note).toContain('Completed steps');
    expect(note).toContain('wrote models.ts');
  });

  test('buildContextNote shows only last 5 completed steps', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    for (let i = 0; i < 8; i++) {
      state.completedSteps.push(`step ${i}`);
    }
    const note = mgr.buildContextNote(state);
    // Should contain step 3-7 (last 5), not step 0-2
    expect(note).toContain('step 7');
    expect(note).not.toContain('step 0');
  });

  test('blockers survive save/load cycle', async () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    state.blockers = ['missing DB schema'];
    await mgr.save(agentId, state);

    const loaded = await mgr.load(agentId);
    expect(loaded!.blockers).toEqual(['missing DB schema']);
  });

  test('load returns null for missing state file', async () => {
    const result = await mgr.load('non-existent-agent');
    expect(result).toBeNull();
  });

  test('techStack survives save/load and appears in context note', async () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    state.techStack = { backend: 'express', orm: 'prisma' };
    await mgr.save(agentId, state);

    const loaded = await mgr.load(agentId);
    expect(loaded!.techStack).toEqual({ backend: 'express', orm: 'prisma' });
    const note = mgr.buildContextNote(loaded!);
    expect(note).toContain('express');
    expect(note).toContain('prisma');
  });

  // ── Phase 2: nextToolCall structured field ────────────────────────────────

  test('setNextToolCall persists tool name and input', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    mgr.setNextToolCall(state, 'write_file', { path: 'src/index.ts', content: '// hello' }, 'Write entry point');
    expect(state.nextToolCall).toBeDefined();
    expect(state.nextToolCall!.tool).toBe('write_file');
    expect(state.nextToolCall!.input).toEqual({ path: 'src/index.ts', content: '// hello' });
    expect(state.nextToolCall!.description).toBe('Write entry point');
  });

  test('setNextToolCall works without description', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    mgr.setNextToolCall(state, 'read_file', { path: 'README.md' });
    expect(state.nextToolCall!.description).toBeUndefined();
  });

  test('clearNextToolCall removes the structured next tool call', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    mgr.setNextToolCall(state, 'write_file', { path: 'a.ts', content: '' });
    expect(state.nextToolCall).toBeDefined();
    mgr.clearNextToolCall(state);
    expect(state.nextToolCall).toBeUndefined();
  });

  test('nextToolCall survives save/load cycle', async () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    mgr.setNextToolCall(state, 'run_command', { command: 'npm install' }, 'Install dependencies');
    await mgr.save(agentId, state);

    const loaded = await mgr.load(agentId);
    expect(loaded!.nextToolCall).toBeDefined();
    expect(loaded!.nextToolCall!.tool).toBe('run_command');
    expect(loaded!.nextToolCall!.description).toBe('Install dependencies');
  });

  test('fresh state has no nextToolCall', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    expect(state.nextToolCall).toBeUndefined();
  });

  test('buildCompactSummary includes nextToolCall info when present', () => {
    const state = mgr.createFresh(agentId, 'build API', 'code');
    state.nextActions = ['Install deps'];
    mgr.setNextToolCall(state, 'run_command', { command: 'npm install' });
    const summary = mgr.buildCompactSummary(state);
    expect(summary).toContain('run_command');
  });
});
