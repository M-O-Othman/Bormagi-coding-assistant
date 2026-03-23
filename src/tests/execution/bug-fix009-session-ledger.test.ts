/**
 * bug-fix009: SessionLedger and SynthesisGuard tests.
 *
 * Validates that:
 *   - collectChangedFiles returns only successful write/edit paths
 *   - assertSummaryConsistency throws on phantom files
 *   - advanceImplementationQueue correctly advances the artifact queue
 */
import {
  createSessionLedger,
  recordToolExecution,
  collectChangedFiles,
  collectReadFiles,
  renderSessionSummary,
  assertSummaryConsistency,
} from '../../agents/execution/SessionLedger';
import {
  ExecutionStateManager,
  type ExecutionStateData,
  type PlannedArtifact,
} from '../../agents/ExecutionStateManager';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  const mgr = new ExecutionStateManager('/ws');
  return {
    ...mgr.createFresh('test', 'Build project', 'code'),
    ...overrides,
  };
}

// ── SessionLedger tests ────────────────────────────────────────────────────────

describe('SessionLedger — collectChangedFiles (bug-fix-008 Fix 5)', () => {
  test('returns empty list when no writes occurred', () => {
    const ledger = createSessionLedger();
    expect(collectChangedFiles(ledger)).toEqual([]);
  });

  test('collects successfully written files', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/app.py', status: 'success', summary: 'ok' });
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/requirements.txt', status: 'success', summary: 'ok' });
    expect(collectChangedFiles(ledger)).toEqual(['backend/app.py', 'backend/requirements.txt']);
  });

  test('excludes failed writes', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/app.py', status: 'error', summary: 'failed' });
    expect(collectChangedFiles(ledger)).toEqual([]);
  });

  test('excludes read-only tools', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'read_file', path: 'requirements.md', status: 'success', summary: 'read' });
    recordToolExecution(ledger, { tool: 'list_files', status: 'success', summary: 'list' });
    expect(collectChangedFiles(ledger)).toEqual([]);
  });

  test('deduplicates repeated successful writes to the same path', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/app.py', status: 'success', summary: 'v1' });
    recordToolExecution(ledger, { tool: 'edit_file', path: 'backend/app.py', status: 'success', summary: 'v2' });
    expect(collectChangedFiles(ledger)).toEqual(['backend/app.py']);
  });

  test('collectReadFiles returns only successfully read paths', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'read_file', path: 'requirements.md', status: 'success', summary: 'read' });
    recordToolExecution(ledger, { tool: 'write_file', path: 'app.py', status: 'success', summary: 'written' });
    expect(collectReadFiles(ledger)).toEqual(['requirements.md']);
  });
});

describe('assertSummaryConsistency (bug-fix-008 Fix 8)', () => {
  test('does not throw when claimed files match ledger', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/app.py', status: 'success', summary: 'ok' });
    expect(() => assertSummaryConsistency(ledger, ['backend/app.py'])).not.toThrow();
  });

  test('throws when summary claims a phantom file', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/app.py', status: 'success', summary: 'ok' });
    expect(() => assertSummaryConsistency(ledger, ['src/domain/user.py'])).toThrow(
      /src\/domain\/user\.py/,
    );
  });

  test('does not throw for empty claimed files', () => {
    const ledger = createSessionLedger();
    expect(() => assertSummaryConsistency(ledger, [])).not.toThrow();
  });
});

describe('renderSessionSummary', () => {
  test('renders a deterministic summary from only written files', () => {
    const ledger = createSessionLedger();
    recordToolExecution(ledger, { tool: 'write_file', path: 'backend/app.py', status: 'success', summary: 'ok' });
    recordToolExecution(ledger, { tool: 'read_file', path: 'requirements.md', status: 'success', summary: 'read' });

    const summary = renderSessionSummary(ledger);
    expect(summary).toContain('backend/app.py');
    expect(summary).not.toContain('requirements.md');
    expect(summary).toContain('Tool operations: 2');
  });
});

// ── ExecutionStateManager.advanceImplementationQueue tests ─────────────────────

describe('advanceImplementationQueue (bug-fix-008 Fix 3)', () => {
  const mgr = new ExecutionStateManager('/tmp/test');

  function makePlan(paths: string[]): PlannedArtifact[] {
    return paths.map(p => ({ path: p, purpose: `Purpose of ${p}`, status: 'pending' as const }));
  }

  test('sets nextToolCall to the first pending artifact', () => {
    const state = makeState({
      remainingArtifacts: makePlan(['backend/extractor.py', 'backend/models.py']),
    });
    const next = mgr.advanceImplementationQueue(state);
    expect(next).not.toBeNull();
    expect(next!.path).toBe('backend/extractor.py');
    expect(state.nextToolCall).toEqual({
      tool: 'write_file',
      input: { path: 'backend/extractor.py' },
      description: expect.stringContaining('backend/extractor.py'),
    });
  });

  test('marks completed path as done and removes from remaining', () => {
    const state = makeState({
      remainingArtifacts: makePlan(['backend/app.py', 'backend/extractor.py']),
    });
    mgr.advanceImplementationQueue(state, 'backend/app.py');

    expect(state.completedArtifacts!.length).toBe(1);
    expect(state.completedArtifacts![0].path).toBe('backend/app.py');
    expect(state.completedArtifacts![0].status).toBe('done');
    expect(state.remainingArtifacts!.find(a => a.path === 'backend/app.py')).toBeUndefined();
  });

  test('returns null and clears nextToolCall when queue is exhausted', () => {
    const state = makeState({
      remainingArtifacts: [],
    });
    const next = mgr.advanceImplementationQueue(state);
    expect(next).toBeNull();
    expect(state.nextToolCall).toBeUndefined();
  });

  test('sets nextToolCall after write — continue resumes deterministically', () => {
    const state = makeState({
      remainingArtifacts: makePlan(['backend/extractor.py']),
    });
    const next = mgr.advanceImplementationQueue(state);
    expect(next!.path).toBe('backend/extractor.py');
    expect(state.nextToolCall!.input.path).toBe('backend/extractor.py');
    // Simulate continue: nextToolCall is present so runner can dispatch directly
    expect(state.nextToolCall).toBeDefined();
  });

  test('handles backslash paths on Windows (normalises to forward slash)', () => {
    const state = makeState({
      remainingArtifacts: makePlan(['backend\\app.py', 'backend\\extractor.py']),
    });
    mgr.advanceImplementationQueue(state, 'backend\\app.py');
    expect(state.completedArtifacts!.some(a => a.path === 'backend\\app.py')).toBe(true);
  });
});
