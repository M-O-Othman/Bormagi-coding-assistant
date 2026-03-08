// ─── Integration tests: Compaction flow + Session checkpoint ─────────────────
//
// Tests the end-to-end compaction path and the session checkpoint round-trip.
// The compact() function is tested against a stub provider that returns valid JSON.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compact, shouldCompact, formatCompactedHistory } from '../../context/ContextCompactor';
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  buildCheckpointState,
} from '../../memory/SessionCheckpoint';
import { EnhancedSessionMemory } from '../../memory/EnhancedSessionMemory';
import type {
  CompactionInput,
  CompactedHistory,
  CheckpointState,
} from '../../context/types';
import type { ILLMProvider } from '../../providers/ILLMProvider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-compact-test-'));
}

function makeInput(messageCount = 10): CompactionInput {
  const transcript = Array.from({ length: messageCount }, (_, i) => ({
    role:    (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i + 1}: some content about the task.`,
  }));
  return {
    transcript,
    recentArtifacts: ['src/foo.ts', 'src/bar.ts'],
    activeMode:      'edit',
    currentGoal:     'Refactor the authentication module.',
  };
}

/** Stub provider that returns a well-formed JSON compaction result. */
function makeStubProvider(returnJson: object): ILLMProvider {
  return {
    providerType: 'stub',
    model:        'stub-model',
    async *stream() {
      yield { type: 'text' as const, delta: JSON.stringify(returnJson) };
    },
  };
}

/** Stub provider that throws on stream to exercise fallback path. */
function makeErrorProvider(): ILLMProvider {
  return {
    providerType: 'stub',
    model:        'stub-error',
    async *stream(): AsyncIterable<never> {
      throw new Error('Provider unavailable');
    },
  };
}

// ─── compact() ───────────────────────────────────────────────────────────────

describe('compact()', () => {
  const validJson: CompactedHistory = {
    currentObjective:  'Refactor auth module.',
    decisions:         ['Use refresh tokens'],
    blockers:          [],
    recentActions:     ['Edited AuthService.ts'],
    recentArtifacts:   ['src/auth/AuthService.ts'],
    pendingNextSteps:  ['Write tests'],
    narrativeSummary:  'The session focused on refactoring auth.',
  };

  test('returns structured output from provider JSON', async () => {
    const input    = makeInput();
    const provider = makeStubProvider(validJson);
    const result   = await compact(input, provider, 'edit');

    expect(result.structured.currentObjective).toBe('Refactor auth module.');
    expect(result.structured.decisions).toContain('Use refresh tokens');
    expect(result.droppedMessages).toBe(input.transcript.length);
  });

  test('narrative contains the objective', async () => {
    const input    = makeInput();
    const provider = makeStubProvider(validJson);
    const result   = await compact(input, provider, 'edit');

    expect(result.narrative).toContain('Refactor auth module.');
    expect(result.narrative).toContain('[Session compacted');
  });

  test('falls back gracefully when provider throws', async () => {
    const input    = makeInput();
    const provider = makeErrorProvider();
    const result   = await compact(input, provider, 'debug');

    // Should not throw; should return a plausible fallback.
    expect(result.droppedMessages).toBe(input.transcript.length);
    expect(typeof result.narrative).toBe('string');
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  test('falls back gracefully when provider returns invalid JSON', async () => {
    const badProvider: ILLMProvider = {
      providerType: 'stub',
      model:        'stub-bad-json',
      async *stream() {
        yield { type: 'text' as const, delta: 'THIS IS NOT JSON' };
      },
    };
    const input  = makeInput();
    const result = await compact(input, badProvider, 'plan');
    expect(result.droppedMessages).toBe(input.transcript.length);
  });

  test('handles partial/missing fields in provider JSON', async () => {
    const partialJson = { currentObjective: 'Do stuff.' }; // missing arrays
    const input    = makeInput();
    const provider = makeStubProvider(partialJson);
    const result   = await compact(input, provider, 'edit');

    expect(result.structured.decisions).toEqual([]);
    expect(result.structured.blockers).toEqual([]);
    expect(result.structured.pendingNextSteps).toEqual([]);
  });

  test('strips markdown fences from provider output', async () => {
    const jsonStr  = JSON.stringify(validJson);
    const fencedProvider: ILLMProvider = {
      providerType: 'stub',
      model:        'stub-fenced',
      async *stream() {
        yield { type: 'text' as const, delta: `\`\`\`json\n${jsonStr}\n\`\`\`` };
      },
    };
    const input  = makeInput();
    const result = await compact(input, fencedProvider, 'edit');
    expect(result.structured.currentObjective).toBe('Refactor auth module.');
  });
});

// ─── SessionCheckpoint ────────────────────────────────────────────────────────

describe('saveCheckpoint / loadCheckpoint', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function makeState(sessionId = 'sess-001'): CheckpointState {
    return buildCheckpointState(sessionId, {
      activeMode:           'edit',
      currentPlan:          ['Step 1', 'Step 2'],
      recentEditedFiles:    ['src/foo.ts'],
      pendingToolArtifacts: [],
    });
  }

  test('round-trips a checkpoint', async () => {
    const state = makeState();
    await saveCheckpoint(tmpDir, state);
    const loaded = await loadCheckpoint(tmpDir, state.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('sess-001');
    expect(loaded!.activeMode).toBe('edit');
    expect(loaded!.currentPlan).toEqual(['Step 1', 'Step 2']);
  });

  test('loadCheckpoint returns null when no file exists', async () => {
    const result = await loadCheckpoint(tmpDir, 'nonexistent');
    expect(result).toBeNull();
  });

  test('loadCheckpoint returns null for corrupt JSON', async () => {
    const dir = path.join(tmpDir, '.bormagi', 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-bad.json'), 'NOTJSON', 'utf-8');
    const result = await loadCheckpoint(tmpDir, 'sess-bad');
    expect(result).toBeNull();
  });

  test('saveCheckpoint sets savedAtUtc', async () => {
    const state = makeState();
    await saveCheckpoint(tmpDir, state);
    const loaded = await loadCheckpoint(tmpDir, state.sessionId);
    expect(loaded!.savedAtUtc).toBeTruthy();
    expect(new Date(loaded!.savedAtUtc).getFullYear()).toBeGreaterThan(2020);
  });

  test('overwrites an existing checkpoint', async () => {
    const state1 = makeState();
    await saveCheckpoint(tmpDir, state1);

    const state2 = { ...state1, currentPlan: ['Updated step'] };
    await saveCheckpoint(tmpDir, state2);

    const loaded = await loadCheckpoint(tmpDir, state1.sessionId);
    expect(loaded!.currentPlan).toEqual(['Updated step']);
  });
});

describe('listCheckpoints', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns empty array when no checkpoints exist', () => {
    expect(listCheckpoints(tmpDir)).toEqual([]);
  });

  test('returns session IDs for existing checkpoints', async () => {
    await saveCheckpoint(tmpDir, buildCheckpointState('sess-a', { activeMode: 'plan', currentPlan: [], recentEditedFiles: [], pendingToolArtifacts: [] }));
    await saveCheckpoint(tmpDir, buildCheckpointState('sess-b', { activeMode: 'edit', currentPlan: [], recentEditedFiles: [], pendingToolArtifacts: [] }));
    const ids = listCheckpoints(tmpDir);
    expect(ids).toContain('sess-a');
    expect(ids).toContain('sess-b');
  });
});

describe('deleteCheckpoint', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('removes the checkpoint file', async () => {
    const state = buildCheckpointState('sess-del', { activeMode: 'debug', currentPlan: [], recentEditedFiles: [], pendingToolArtifacts: [] });
    await saveCheckpoint(tmpDir, state);
    expect(await loadCheckpoint(tmpDir, 'sess-del')).not.toBeNull();

    deleteCheckpoint(tmpDir, 'sess-del');
    expect(await loadCheckpoint(tmpDir, 'sess-del')).toBeNull();
  });

  test('does not throw when file does not exist', () => {
    expect(() => deleteCheckpoint(tmpDir, 'nonexistent')).not.toThrow();
  });
});

// ─── EnhancedSessionMemory ────────────────────────────────────────────────────

describe('EnhancedSessionMemory', () => {
  let tmpDir: string;
  let memory: EnhancedSessionMemory;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    memory = new EnhancedSessionMemory(tmpDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('starts with empty state', () => {
    const s = memory.getState('agent-1');
    expect(s.currentPlan).toEqual([]);
    expect(s.recentEditedFiles).toEqual([]);
    expect(s.decisions).toEqual([]);
  });

  test('setGoal / getState', () => {
    memory.setGoal('agent-1', 'Build the login feature');
    expect(memory.getState('agent-1').currentGoal).toBe('Build the login feature');
  });

  test('setPlan replaces current plan', () => {
    memory.setPlan('agent-1', ['Step A', 'Step B']);
    expect(memory.getState('agent-1').currentPlan).toEqual(['Step A', 'Step B']);
    memory.setPlan('agent-1', ['Only step']);
    expect(memory.getState('agent-1').currentPlan).toEqual(['Only step']);
  });

  test('markStepDone removes the step at index', () => {
    memory.setPlan('agent-1', ['Step 1', 'Step 2', 'Step 3']);
    memory.markStepDone('agent-1', 1);
    expect(memory.getState('agent-1').currentPlan).toEqual(['Step 1', 'Step 3']);
  });

  test('recordEditedFile keeps newest at front, caps at 20', () => {
    for (let i = 0; i < 25; i++) {
      memory.recordEditedFile('agent-1', `src/file${i}.ts`);
    }
    const files = memory.getState('agent-1').recentEditedFiles;
    expect(files.length).toBe(20);
    expect(files[0]).toBe('src/file24.ts'); // newest first
  });

  test('addDecision creates an entry with id', () => {
    const d = memory.addDecision('agent-1', { title: 'Use JWT', decision: 'Use HS256 algorithm', rationale: 'Simple and fast' });
    expect(d.id).toBeTruthy();
    expect(memory.getState('agent-1').decisions).toHaveLength(1);
    expect(memory.getState('agent-1').decisions[0].title).toBe('Use JWT');
  });

  test('addUnresolvedQuestion deduplicates', () => {
    memory.addUnresolvedQuestion('agent-1', 'Is CORS needed?');
    memory.addUnresolvedQuestion('agent-1', 'Is CORS needed?');
    expect(memory.getState('agent-1').unresolvedQuestions).toHaveLength(1);
  });

  test('resolveQuestion removes the entry', () => {
    memory.addUnresolvedQuestion('agent-1', 'Question A');
    memory.resolveQuestion('agent-1', 'Question A');
    expect(memory.getState('agent-1').unresolvedQuestions).toHaveLength(0);
  });

  test('buildPromptSummary returns non-empty string when state has content', () => {
    memory.setGoal('agent-1', 'Fix the bug');
    memory.setPlan('agent-1', ['Step 1', 'Step 2']);
    const summary = memory.buildPromptSummary('agent-1', 'debug');
    expect(summary).toContain('Fix the bug');
    expect(summary).toContain('Step 1');
  });

  test('persistState and reload round-trips state', async () => {
    memory.setGoal('agent-1', 'Persisted goal');
    memory.recordEditedFile('agent-1', 'src/index.ts');
    await memory.persistState('agent-1');

    // Load fresh instance.
    const memory2 = new EnhancedSessionMemory(tmpDir);
    const s = memory2.getState('agent-1');
    expect(s.currentGoal).toBe('Persisted goal');
    expect(s.recentEditedFiles).toContain('src/index.ts');
  });
});
