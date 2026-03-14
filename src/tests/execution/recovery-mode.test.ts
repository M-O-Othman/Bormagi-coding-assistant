import { RecoveryManager } from '../../agents/execution/RecoveryManager';
import { PromptAssembler } from '../../agents/execution/PromptAssembler';
import type { ExecutionStateData } from '../../agents/ExecutionStateManager';
import type { ChatMessage } from '../../types';

const HEADERS = {
  executionStateHeader: '[Execution State]',
  workspaceHeader: '[Workspace]',
  milestoneSummaryPrefix: 'Milestone: ',
};

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  return {
    version: 2,
    agentId: 'test-agent',
    objective: 'Build a test feature',
    mode: 'code',
    workspaceRoot: '/workspace',
    resolvedInputs: [],
    artifactsCreated: [],
    completedSteps: [],
    nextActions: ['Write src/index.ts'],
    blockers: [],
    techStack: {},
    iterationsUsed: 1,
    plannedFileBatch: [],
    updatedAt: new Date().toISOString(),
    executedTools: [],
    runPhase: 'RUNNING',
    blockedReadCount: 0,
    continueCount: 0,
    continueIterationSnapshot: 0,
    ...overrides,
  };
}

function makeManager(
  state: ExecutionStateData,
  messages: ChatMessage[] = [],
): RecoveryManager {
  const assembler = new PromptAssembler(HEADERS);
  return new RecoveryManager(state, messages, assembler, 'You are a coder.', 'scaffolded');
}

// ── shouldRecover() ────────────────────────────────────────────────────────

describe('RecoveryManager.shouldRecover()', () => {
  it('returns REPEATED_BLOCKED_READS when blockedReadCount >= 3', () => {
    const mgr = makeManager(makeState({ blockedReadCount: 3 }));
    expect(mgr.shouldRecover()).toBe('REPEATED_BLOCKED_READS');
  });

  it('returns REPEATED_BLOCKED_READS when blockedReadCount > 3', () => {
    const mgr = makeManager(makeState({ blockedReadCount: 5 }));
    expect(mgr.shouldRecover()).toBe('REPEATED_BLOCKED_READS');
  });

  it('returns REPEATED_CONTINUE_NO_PROGRESS when continueCount >= 2 and no new iterations', () => {
    const mgr = makeManager(makeState({
      continueCount: 2,
      iterationsUsed: 4,
      continueIterationSnapshot: 4,
    }));
    expect(mgr.shouldRecover()).toBe('REPEATED_CONTINUE_NO_PROGRESS');
  });

  it('does NOT return REPEATED_CONTINUE_NO_PROGRESS when progress was made', () => {
    const mgr = makeManager(makeState({
      continueCount: 2,
      iterationsUsed: 6,
      continueIterationSnapshot: 4,
    }));
    expect(mgr.shouldRecover()).not.toBe('REPEATED_CONTINUE_NO_PROGRESS');
  });

  it('returns MISSING_NEXT_ACTION when RUNNING with no nextActions after 5+ iterations with no artifacts', () => {
    const mgr = makeManager(makeState({
      runPhase: 'RUNNING',
      iterationsUsed: 5,
      nextActions: [],
      nextToolCall: undefined,
      artifactsCreated: [],
    }));
    expect(mgr.shouldRecover()).toBe('MISSING_NEXT_ACTION');
  });

  it('does NOT return MISSING_NEXT_ACTION when iterationsUsed < 5', () => {
    const mgr = makeManager(makeState({
      runPhase: 'RUNNING',
      iterationsUsed: 4,
      nextActions: [],
      nextToolCall: undefined,
      artifactsCreated: [],
    }));
    expect(mgr.shouldRecover()).toBeNull();
  });

  it('does NOT return MISSING_NEXT_ACTION when artifacts have been created', () => {
    const mgr = makeManager(makeState({
      runPhase: 'RUNNING',
      iterationsUsed: 10,
      nextActions: [],
      nextToolCall: undefined,
      artifactsCreated: ['src/index.ts'],
    }));
    expect(mgr.shouldRecover()).toBeNull();
  });

  it('returns PROTOCOL_TEXT_IN_TRANSCRIPT when messages contain [write_file:', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'Working on it [write_file: src/index.ts]' },
    ];
    const mgr = makeManager(makeState(), messages);
    expect(mgr.shouldRecover()).toBe('PROTOCOL_TEXT_IN_TRANSCRIPT');
  });

  it('returns null when state is clean and healthy', () => {
    const mgr = makeManager(makeState({
      blockedReadCount: 0,
      continueCount: 0,
      iterationsUsed: 1,
      nextActions: ['Write src/index.ts'],
      runPhase: 'RUNNING',
    }));
    expect(mgr.shouldRecover()).toBeNull();
  });
});

// ── rebuild() ─────────────────────────────────────────────────────────────

describe('RecoveryManager.rebuild()', () => {
  it('returns success when executedTools has entries', () => {
    const state = makeState({
      executedTools: [{ name: 'write_file', timestamp: new Date().toISOString(), inputPath: 'src/index.ts' }],
      artifactsCreated: ['src/index.ts'],
    });
    const result = makeManager(state).rebuild('MISSING_NEXT_ACTION');
    expect(result.success).toBe(true);
    expect(result.trigger).toBe('MISSING_NEXT_ACTION');
  });

  it('returns success even with no executed tools', () => {
    const state = makeState({ executedTools: [], iterationsUsed: 0 });
    const result = makeManager(state).rebuild('REPEATED_BLOCKED_READS');
    expect(result.success).toBe(true);
  });

  it('cleanMessages is defined and non-empty after successful rebuild', () => {
    const state = makeState({
      executedTools: [{ name: 'read_file', timestamp: new Date().toISOString() }],
    });
    const result = makeManager(state).rebuild('REPEATED_CONTINUE_NO_PROGRESS');
    expect(result.success).toBe(true);
    expect(result.cleanMessages).toBeDefined();
    expect(result.cleanMessages!.length).toBeGreaterThan(0);
  });

  it('cleanMessages contain no protocol text after rebuild', () => {
    const state = makeState();
    const result = makeManager(state).rebuild('PROTOCOL_TEXT_IN_TRANSCRIPT');
    expect(result.success).toBe(true);
    const allContent = result.cleanMessages!.map(m => m.content).join('\n');
    expect(allContent).not.toMatch(/\[write_file:/);
    expect(allContent).not.toMatch(/\[edit_file:/);
    expect(allContent).not.toMatch(/<tool_result/);
  });
});
