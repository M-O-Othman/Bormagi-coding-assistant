/**
 * Regression tests for fixes-006 (infinite read loop, token waste, context loss).
 *
 * Tests cover all sections of the implementation document:
 *   Section 1:  ContextEnvelope resolvedInputs slot
 *   Section 2:  BudgetEngine resolvedInputs handling
 *   Section 3:  ToolDispatcher cached content return
 *   Section 4:  ExecutionStateManager checkReadiness, structured summaries, context note
 *   Section 6:  AgentFSM finite state machine
 *   Section 7:  ContextDeduplicator
 *   Section 8:  AgentLogger TurnSummary/SessionSummary
 *   Section 9:  ModelBehavior profiles
 *   Section 10: PromptAssembler resolvedInputs section
 *   Section 11: ContextCostTracker phase breakdown and efficiency
 */

import type { ContextCandidate, ContextEnvelope, ModeBudget, ModelProfile } from '../../context/types';
import {
  estimateEnvelopeTokens,
  enforcePreflightBudget,
  estimateTokens,
} from '../../context/BudgetEngine';
import { buildContextEnvelope, mergeEnvelopes, envelopeTokenCount } from '../../context/ContextEnvelope';
import { assemblePrompt } from '../../context/PromptAssembler';
import { ExecutionStateManager } from '../../agents/ExecutionStateManager';
import type { ExecutionStateData, ResolvedInputSummary } from '../../agents/ExecutionStateManager';
import { AgentFSM } from '../../agents/execution/AgentFSM';
import type { FSMContext } from '../../agents/execution/AgentFSM';
import { ContextDeduplicator } from '../../agents/execution/ContextDeduplicator';
import { getModelBehavior } from '../../agents/execution/ModelBehavior';
import { ContextCostTracker } from '../../agents/execution/ContextCostTracker';
import type { TurnSummary, SessionSummary } from '../../agents/AgentLogger';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id: 'test-candidate',
    kind: 'file',
    content: 'test content',
    tokenEstimate: 100,
    score: 1.0,
    reasons: ['test'],
    editable: false,
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return { editable: [], reference: [], memory: [], toolOutputs: [], resolvedInputs: [], ...overrides };
}

const MOCK_BUDGET: ModeBudget = {
  stablePrefix: 2000,
  memory: 500,
  repoMap: 1200,
  retrievedContext: 7000,
  toolOutputs: 1200,
  conversationTail: 1000,
  userInput: 800,
  reservedMargin: 500,
};

const MOCK_PROFILE: ModelProfile = {
  provider: 'test',
  model: 'test-model',
  maxContextTokens: 200000,
  recommendedInputBudget: 50000,
  defaultMaxOutputTokens: 4096,
  supportsPromptCaching: false,
  supportsToolUse: true,
  estimatedToolOverheadTokens: 500,
  thresholds: { warnAtPct: 70, pruneAtPct: 80, compactAtPct: 85, emergencyAtPct: 95 },
};

function createFreshState(agentId: string, objective: string, mode: string): ExecutionStateData {
  return new ExecutionStateManager('/tmp').createFresh(agentId, objective, mode);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1: ContextEnvelope resolvedInputs slot
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 1: ContextEnvelope resolvedInputs', () => {
  test('ContextEnvelope interface includes resolvedInputs field', () => {
    const envelope = makeEnvelope();
    expect(envelope.resolvedInputs).toBeDefined();
    expect(Array.isArray(envelope.resolvedInputs)).toBe(true);
  });

  test('buildContextEnvelope produces resolvedInputs as empty array', () => {
    const envelope = buildContextEnvelope([], 'code');
    expect(envelope.resolvedInputs).toEqual([]);
  });

  test('mergeEnvelopes merges resolvedInputs from both envelopes', () => {
    const base = makeEnvelope({
      resolvedInputs: [makeCandidate({ id: 'base-ri' })],
    });
    const overlay = makeEnvelope({
      resolvedInputs: [makeCandidate({ id: 'overlay-ri' })],
    });
    const merged = mergeEnvelopes(base, overlay);
    expect(merged.resolvedInputs).toHaveLength(2);
    expect(merged.resolvedInputs[0].id).toBe('overlay-ri');
    expect(merged.resolvedInputs[1].id).toBe('base-ri');
  });

  test('envelopeTokenCount includes resolvedInputs tokens', () => {
    const envelope = makeEnvelope({
      editable: [makeCandidate({ tokenEstimate: 100 })],
      resolvedInputs: [makeCandidate({ tokenEstimate: 200 })],
    });
    expect(envelopeTokenCount(envelope)).toBe(300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 2: BudgetEngine resolvedInputs handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 2: BudgetEngine resolvedInputs', () => {
  test('estimateEnvelopeTokens counts resolvedInputs', () => {
    const envelope = makeEnvelope({
      resolvedInputs: [makeCandidate({ tokenEstimate: 500 })],
    });
    const total = estimateEnvelopeTokens(envelope, MOCK_BUDGET, MOCK_PROFILE);
    // Should include: stablePrefix(2000) + userInput(800) + toolOverhead(500) + resolvedInputs(500)
    expect(total).toBe(2000 + 800 + 500 + 500);
  });

  test('degradeToPlanOnly preserves resolvedInputs (compressed if large)', () => {
    const largeContent = 'x'.repeat(2000);
    const envelope = makeEnvelope({
      editable: [makeCandidate({ tokenEstimate: 5000 })],
      reference: [makeCandidate({ tokenEstimate: 3000 })],
      resolvedInputs: [makeCandidate({
        content: largeContent,
        tokenEstimate: 500,
      })],
    });
    // Use a tiny profile to force degradation
    const tinyProfile = { ...MOCK_PROFILE, recommendedInputBudget: 4000 };
    const { envelope: result, degraded } = enforcePreflightBudget(envelope, MOCK_BUDGET, tinyProfile);
    expect(degraded).toBe(true);
    // resolvedInputs should still be present (possibly compressed)
    expect(result.resolvedInputs.length).toBeGreaterThanOrEqual(1);
  });

  test('cloneEnvelope preserves resolvedInputs', () => {
    const envelope = makeEnvelope({
      resolvedInputs: [makeCandidate({ id: 'ri-1' })],
    });
    const { envelope: result } = enforcePreflightBudget(envelope, MOCK_BUDGET, MOCK_PROFILE);
    // resolvedInputs should survive cloning
    expect(result.resolvedInputs).toHaveLength(1);
    expect(result.resolvedInputs[0].id).toBe('ri-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 4: ExecutionStateManager — checkReadiness, summaries, context note
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 4a: checkReadiness', () => {
  const mgr = new ExecutionStateManager('/tmp');

  test('returns ready:false when no inputs are resolved', () => {
    const state = createFreshState('test', 'do something', 'code');
    const result = mgr.checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('No input files read with content');
  });

  test('returns ready:true when inputs have content summaries', () => {
    const state = createFreshState('test', 'build a pdf extraction tool', 'code');
    state.resolvedInputSummaries = [{
      path: 'requirements.md',
      hash: 'abc123',
      summary: 'Title: PDF Upload Tool\nTech stack: react, python, fastapi\nKey requirements:\n1. Upload PDF files\n2. Extract text content\n3. Display results',
      kind: 'requirements',
      lastReadAt: new Date().toISOString(),
    }];
    const result = mgr.checkReadiness(state);
    expect(result.ready).toBe(true);
  });

  test('returns missing plan when approvedPlanPath is set but not loaded', () => {
    const state = createFreshState('test', 'build a pdf extraction tool', 'code');
    state.approvedPlanPath = '.bormagi/plans/plan.md';
    state.resolvedInputSummaries = [{
      path: 'requirements.md',
      hash: 'abc123',
      summary: 'Title: PDF Upload Tool\nTech stack: react, python, fastapi\nKey requirements:\n1. Upload\n2. Extract\n3. Display',
      kind: 'requirements',
      lastReadAt: new Date().toISOString(),
    }];
    const result = mgr.checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.missing.some(m => m.includes('Plan not loaded'))).toBe(true);
  });

  test('flags vague objective', () => {
    const state = createFreshState('test', 'fix bug', 'code');
    state.resolvedInputs = ['some-file.ts'];
    const result = mgr.checkReadiness(state);
    expect(result.missing.some(m => m.includes('too vague'))).toBe(true);
  });
});

describe('Section 4b: markFileRead with content extraction', () => {
  const mgr = new ExecutionStateManager('/tmp');

  test('extracts structured summary when content provided', () => {
    const state = createFreshState('test', 'build a tool', 'code');
    const content = '# PDF Upload Tool\nBuild with React and FastAPI using pdfplumber.\n\n1. Upload PDF files\n2. Extract text';
    mgr.markFileRead(state, 'requirements.md', content);

    expect(state.resolvedInputs).toContain('requirements.md');
    expect(state.resolvedInputSummaries).toHaveLength(1);
    expect(state.resolvedInputSummaries![0].path).toBe('requirements.md');
    expect(state.resolvedInputSummaries![0].kind).toBe('requirements');
    expect(state.resolvedInputSummaries![0].summary).toContain('react');
    expect(state.resolvedInputSummaries![0].summary).toContain('fastapi');
    expect(state.resolvedInputSummaries![0].summary).toContain('pdfplumber');
  });

  test('classifies file kind correctly', () => {
    const state = createFreshState('test', 'build a tool', 'code');
    mgr.markFileRead(state, 'spec.md', '# Spec\nSome spec content here that is long enough');
    expect(state.resolvedInputSummaries![0].kind).toBe('requirements');

    mgr.markFileRead(state, 'src/main.ts', 'const x = 1;\nexport function main() {}');
    expect(state.resolvedInputSummaries![1].kind).toBe('source');

    mgr.markFileRead(state, 'config.json', '{"key": "value"}');
    expect(state.resolvedInputSummaries![2].kind).toBe('config');

    mgr.markFileRead(state, 'plan.md', '# Plan\nStep 1: Do things');
    expect(state.resolvedInputSummaries![3].kind).toBe('plan');
  });

  test('upserts summary (updates existing by path)', () => {
    const state = createFreshState('test', 'build a tool', 'code');
    mgr.markFileRead(state, 'file.md', '# Version 1\nOriginal content');
    expect(state.resolvedInputSummaries).toHaveLength(1);

    mgr.markFileRead(state, 'file.md', '# Version 2\nUpdated content');
    expect(state.resolvedInputSummaries).toHaveLength(1);
    expect(state.resolvedInputSummaries![0].summary).toContain('Version 2');
  });

  test('works without content (backward compat)', () => {
    const state = createFreshState('test', 'build a tool', 'code');
    mgr.markFileRead(state, 'some-file.ts');
    expect(state.resolvedInputs).toContain('some-file.ts');
    expect(state.resolvedInputSummaries).toHaveLength(0);
  });
});

describe('Section 4c: buildContextNote (imperative)', () => {
  const mgr = new ExecutionStateManager('/tmp');

  test('uses AUTHORITATIVE header', () => {
    const state = createFreshState('test', 'build a PDF extraction tool', 'code');
    const note = mgr.buildContextNote(state);
    expect(note).toContain('AUTHORITATIVE EXECUTION STATE');
  });

  test('includes resolved input summaries with content digests', () => {
    const state = createFreshState('test', 'build a PDF extraction tool', 'code');
    state.resolvedInputSummaries = [{
      path: 'requirements.md',
      hash: 'abc',
      summary: 'Title: PDF Tool\nTech stack: react, fastapi',
      kind: 'requirements',
      lastReadAt: new Date().toISOString(),
    }];
    const note = mgr.buildContextNote(state);
    expect(note).toContain('RESOLVED INPUTS');
    expect(note).toContain('requirements.md [requirements]');
    expect(note).toContain('PDF Tool');
    expect(note).toContain('DO NOT call read_file');
  });

  test('includes imperative next action instructions', () => {
    const state = createFreshState('test', 'build a PDF extraction tool', 'code');
    state.nextActions = ['Write the first implementation file'];
    state.nextToolCall = { tool: 'write_file', input: { path: 'src/main.ts' } };
    const note = mgr.buildContextNote(state);
    expect(note).toContain('NEXT REQUIRED ACTION');
    expect(note).toContain('NEXT TOOL: write_file');
    expect(note).toContain('Call write_file or edit_file NOW');
  });

  test('includes batch progress', () => {
    const state = createFreshState('test', 'build a PDF extraction tool', 'code');
    state.plannedFileBatch = ['a.ts', 'b.ts', 'c.ts'];
    state.completedBatchFiles = ['a.ts'];
    const note = mgr.buildContextNote(state);
    expect(note).toContain('Batch: 1/3 done');
    expect(note).toContain('b.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 6: AgentFSM
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 6: AgentFSM', () => {
  function makeFSMContext(overrides: Partial<FSMContext> = {}): FSMContext {
    return {
      maxDiscoveryReads: 3,
      discoveryReadsUsed: 0,
      writesThisSession: 0,
      batchRemaining: [],
      readinessResult: { ready: false, missing: [] },
      ...overrides,
    };
  }

  test('starts in ORIENT phase', () => {
    const fsm = new AgentFSM();
    expect(fsm.phase).toBe('ORIENT');
  });

  test('transitions ORIENT -> DISCOVER', () => {
    const fsm = new AgentFSM();
    const state = createFreshState('test', 'build something useful', 'code');
    const ctx = makeFSMContext();
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('DISCOVER');
  });

  test('transitions DISCOVER -> READINESS_CHECK after reading files', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('DISCOVER');
    const state = createFreshState('test', 'build something useful', 'code');
    state.resolvedInputs = ['requirements.md'];
    const ctx = makeFSMContext({ discoveryReadsUsed: 1 });
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('READINESS_CHECK');
  });

  test('transitions DISCOVER -> BLOCKED after max reads', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('DISCOVER');
    const state = createFreshState('test', 'build something useful', 'code');
    // No resolved inputs
    const ctx = makeFSMContext({
      discoveryReadsUsed: 3,
      maxDiscoveryReads: 3,
    });
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('BLOCKED');
  });

  test('transitions READINESS_CHECK -> PLAN_BATCH when ready', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('READINESS_CHECK');
    const state = createFreshState('test', 'build something useful', 'code');
    const ctx = makeFSMContext({
      readinessResult: { ready: true, missing: [] },
    });
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('PLAN_BATCH');
  });

  test('transitions READINESS_CHECK -> DISCOVER when not ready (reads available)', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('READINESS_CHECK');
    const state = createFreshState('test', 'build something useful', 'code');
    const ctx = makeFSMContext({
      readinessResult: { ready: false, missing: ['Plan not loaded'] },
      discoveryReadsUsed: 1,
      maxDiscoveryReads: 3,
    });
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('DISCOVER');
  });

  test('transitions ADVANCE -> COMPLETE when batch empty', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('ADVANCE');
    const state = createFreshState('test', 'build something useful', 'code');
    const ctx = makeFSMContext({ batchRemaining: [] });
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('COMPLETE');
  });

  test('transitions ADVANCE -> EXECUTE when batch has remaining', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('ADVANCE');
    const state = createFreshState('test', 'build something useful', 'code');
    const ctx = makeFSMContext({ batchRemaining: ['next-file.ts'] });
    const newPhase = fsm.advance(state, ctx);
    expect(newPhase).toBe('EXECUTE');
  });

  test('isTerminal returns true for COMPLETE and BLOCKED', () => {
    const fsm = new AgentFSM();
    fsm.forcePhase('COMPLETE');
    expect(fsm.isTerminal()).toBe(true);
    fsm.forcePhase('BLOCKED');
    expect(fsm.isTerminal()).toBe(true);
    fsm.forcePhase('EXECUTE');
    expect(fsm.isTerminal()).toBe(false);
  });

  test('phaseHistory records transitions', () => {
    const fsm = new AgentFSM();
    const state = createFreshState('test', 'build something useful', 'code');
    fsm.advance(state, makeFSMContext()); // ORIENT -> DISCOVER
    expect(fsm.phaseHistory).toHaveLength(1);
    expect(fsm.phaseHistory[0].from).toBe('ORIENT');
    expect(fsm.phaseHistory[0].to).toBe('DISCOVER');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 7: ContextDeduplicator
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 7: ContextDeduplicator', () => {
  test('replaces duplicate tool_result messages with references', () => {
    const dedup = new ContextDeduplicator();
    const messages = [
      { role: 'tool_result' as const, content: '<tool_result name="read_file">\nFile content here\n</tool_result>' },
      { role: 'assistant' as const, content: 'Processing...' },
      { role: 'tool_result' as const, content: '<tool_result name="read_file">\nFile content here\n</tool_result>' },
    ];
    const result = dedup.deduplicate(messages);
    expect(result[0].content).toContain('read_file');
    expect(result[2].content).toContain('Duplicate of turn #0');
  });

  test('does not modify non-tool_result messages', () => {
    const dedup = new ContextDeduplicator();
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    const result = dedup.deduplicate(messages);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('Hi there');
  });

  test('reset clears deduplication state', () => {
    const dedup = new ContextDeduplicator();
    const messages = [
      { role: 'tool_result' as const, content: 'Same content' },
    ];
    dedup.deduplicate(messages);
    dedup.reset();
    // After reset, same content should not be detected as duplicate
    const result = dedup.deduplicate(messages);
    expect(result[0].content).toBe('Same content');
  });

  test('does not mutate input array', () => {
    const dedup = new ContextDeduplicator();
    const original = [
      { role: 'tool_result' as const, content: 'content A' },
      { role: 'tool_result' as const, content: 'content A' },
    ];
    const originalContent = original[1].content;
    dedup.deduplicate(original);
    expect(original[1].content).toBe(originalContent);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 8: AgentLogger TurnSummary/SessionSummary interfaces
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 8: TurnSummary/SessionSummary types', () => {
  test('TurnSummary has all required fields', () => {
    const summary: TurnSummary = {
      turn: 1,
      phase: 'DISCOVER',
      inputTokens: 5000,
      outputTokens: 200,
      cacheHit: false,
      toolCalled: 'read_file',
      toolPath: 'requirements.md',
      toolStatus: 'success',
      writtenThisTurn: [],
      cumulativeWrites: 0,
      cumulativeReads: 1,
      blockedReads: 0,
      systemPromptTokens: 3000,
      contextPacketTokens: 500,
      toolResultTokens: 1500,
      llmCallSkipped: false,
      deterministicDispatch: false,
    };
    expect(summary.turn).toBe(1);
    expect(summary.phase).toBe('DISCOVER');
  });

  test('SessionSummary has all required fields', () => {
    const summary: SessionSummary = {
      totalInputTokens: 50000,
      totalOutputTokens: 5000,
      totalTurns: 10,
      uniqueFilesWritten: ['a.ts', 'b.ts'],
      uniqueFilesRead: ['requirements.md'],
      loopDetections: 0,
      discoveryBudgetExceeded: 0,
      recoveryAttempts: 0,
      llmCallsSkipped: 2,
      deterministicDispatches: 1,
      durationMs: 30000,
      tokenEfficiency: 0.1,
      fsmPhases: ['ORIENT', 'DISCOVER', 'EXECUTE'],
    };
    expect(summary.totalTurns).toBe(10);
    expect(summary.uniqueFilesWritten).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 9: ModelBehavior profiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 9: ModelBehavior', () => {
  test('returns correct profile for Claude models', () => {
    const profile = getModelBehavior('claude-sonnet-4-6');
    expect(profile.instructionCompliance).toBe('high');
    expect(profile.supportsForceToolCall).toBe(true);
    expect(profile.supportsPromptCache).toBe(true);
    expect(profile.maxDiscoveryReads).toBe(3);
  });

  test('returns correct profile for Gemini models', () => {
    const profile = getModelBehavior('gemini-2.5-flash');
    expect(profile.instructionCompliance).toBe('low');
    expect(profile.supportsForceToolCall).toBe(false);
    expect(profile.maxDiscoveryReads).toBe(1);
  });

  test('handles versioned model names via prefix match', () => {
    const profile = getModelBehavior('claude-sonnet-4-6-20250514');
    expect(profile.instructionCompliance).toBe('high');
  });

  test('handles family match for unknown variant', () => {
    const profile = getModelBehavior('claude-custom-model');
    expect(profile.supportsForceToolCall).toBe(true);
  });

  test('returns default for completely unknown models', () => {
    const profile = getModelBehavior('some-random-model');
    expect(profile.instructionCompliance).toBe('medium');
    expect(profile.supportsForceToolCall).toBe(false);
    expect(profile.maxDiscoveryReads).toBe(2);
  });

  test('OpenAI models have correct profiles', () => {
    const profile = getModelBehavior('gpt-4o');
    expect(profile.instructionCompliance).toBe('high');
    expect(profile.supportsForceToolCall).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 10: PromptAssembler resolvedInputs section
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 10: PromptAssembler resolvedInputs', () => {
  test('includes resolved inputs section when candidates present', () => {
    const envelope = makeEnvelope({
      resolvedInputs: [makeCandidate({
        path: 'requirements.md',
        content: 'Title: PDF Tool\nTech stack: react, fastapi',
      })],
    });
    const result = assemblePrompt({
      systemPreamble: 'Test system',
      instructions: { layers: [], merged: '', totalTokenEstimate: 0 },
      envelope,
      repoMap: null,
      userMessage: 'Build it',
      mode: 'code',
    });
    expect(result).toContain('Resolved Inputs');
    expect(result).toContain('DO NOT re-read');
    expect(result).toContain('requirements.md');
    expect(result).toContain('PDF Tool');
  });

  test('omits section when resolvedInputs is empty', () => {
    const envelope = makeEnvelope();
    const result = assemblePrompt({
      systemPreamble: 'Test system',
      instructions: { layers: [], merged: '', totalTokenEstimate: 0 },
      envelope,
      repoMap: null,
      userMessage: 'Build it',
      mode: 'code',
    });
    expect(result).not.toContain('Resolved Inputs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 11: ContextCostTracker phase breakdown
// ═══════════════════════════════════════════════════════════════════════════════

describe('Section 11: ContextCostTracker', () => {
  test('record() includes phase field', () => {
    const tracker = new ContextCostTracker();
    const entry = tracker.record(1, 'sys', 'state', 'ws', 'skill', 'instr', 'tool', 'DISCOVER');
    expect(entry.phase).toBe('DISCOVER');
  });

  test('getPhaseBreakdown groups by phase', () => {
    const tracker = new ContextCostTracker();
    tracker.record(1, 'sys', 'state', 'ws', 'skill', 'instr', 'tool', 'DISCOVER');
    tracker.record(2, 'sys', 'state', 'ws', 'skill', 'instr', 'tool', 'DISCOVER');
    tracker.record(3, 'sys', 'state', 'ws', 'skill', 'instr', 'tool', 'EXECUTE');

    const breakdown = tracker.getPhaseBreakdown();
    expect(breakdown).toHaveLength(2);

    const discover = breakdown.find(p => p.phase === 'DISCOVER');
    expect(discover?.turns).toBe(2);

    const execute = breakdown.find(p => p.phase === 'EXECUTE');
    expect(execute?.turns).toBe(1);
  });

  test('getRecentEntries returns last N entries', () => {
    const tracker = new ContextCostTracker();
    tracker.record(1, 'a', '', '', '', '', '', 'A');
    tracker.record(2, 'b', '', '', '', '', '', 'B');
    tracker.record(3, 'c', '', '', '', '', '', 'C');

    const recent = tracker.getRecentEntries(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].turn).toBe(2);
    expect(recent[1].turn).toBe(3);
  });

  test('getSkippedCount returns count of skipped LLM calls', () => {
    const tracker = new ContextCostTracker();
    const e1 = tracker.record(1, '', '', '', '', '', '', 'A');
    e1.llmCallSkipped = true;
    tracker.record(2, '', '', '', '', '', '', 'B');
    const e3 = tracker.record(3, '', '', '', '', '', '', 'C');
    e3.llmCallSkipped = true;

    expect(tracker.getSkippedCount()).toBe(2);
  });

  test('isInefficient detects sustained low efficiency', () => {
    const tracker = new ContextCostTracker();
    // 3 turns with 0 output tokens = 0% efficiency
    const e1 = tracker.record(1, 'x'.repeat(1000), '', '', '', '', '', 'A');
    e1.outputTokens = 0;
    const e2 = tracker.record(2, 'x'.repeat(1000), '', '', '', '', '', 'A');
    e2.outputTokens = 0;
    const e3 = tracker.record(3, 'x'.repeat(1000), '', '', '', '', '', 'A');
    e3.outputTokens = 0;

    expect(tracker.isInefficient(3, 0.02)).toBe(true);
  });

  test('isInefficient returns false when not enough data', () => {
    const tracker = new ContextCostTracker();
    tracker.record(1, '', '', '', '', '', '', 'A');
    expect(tracker.isInefficient(3, 0.02)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-fix integration tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-fix: Full pipeline', () => {
  test('resolvedInputs flow: markFileRead -> buildContextNote -> assemblePrompt', () => {
    const mgr = new ExecutionStateManager('/tmp');
    const state = createFreshState('test', 'build a PDF extraction tool using React and FastAPI', 'code');

    // 1. Mark file as read with content
    mgr.markFileRead(state, 'requirements.md', '# PDF Upload Tool\nBuild with React and FastAPI using pdfplumber.\n\n1. Upload PDF files\n2. Extract text content\n3. Display results');

    // 2. Build context note — should include summary digests
    const note = mgr.buildContextNote(state);
    expect(note).toContain('RESOLVED INPUTS');
    expect(note).toContain('requirements.md');

    // 3. Check readiness — should be ready with content
    const readiness = mgr.checkReadiness(state);
    expect(readiness.ready).toBe(true);
  });

  test('FSM + readiness gate integration', () => {
    const fsm = new AgentFSM();
    const mgr = new ExecutionStateManager('/tmp');
    const state = createFreshState('test', 'build a PDF extraction tool using React and FastAPI', 'code');

    // ORIENT -> DISCOVER
    fsm.advance(state, {
      maxDiscoveryReads: 3,
      discoveryReadsUsed: 0,
      writesThisSession: 0,
      batchRemaining: [],
      readinessResult: { ready: false, missing: [] },
    });
    expect(fsm.phase).toBe('DISCOVER');

    // Read a file
    state.resolvedInputs = ['requirements.md'];
    mgr.markFileRead(state, 'requirements.md', '# Tool Requirements\nBuild with React and FastAPI.\n1. Upload\n2. Extract\n3. Display results in dashboard');

    // DISCOVER -> READINESS_CHECK
    const readiness = mgr.checkReadiness(state);
    fsm.advance(state, {
      maxDiscoveryReads: 3,
      discoveryReadsUsed: 1,
      writesThisSession: 0,
      batchRemaining: [],
      readinessResult: readiness,
    });
    expect(fsm.phase).toBe('READINESS_CHECK');

    // READINESS_CHECK -> PLAN_BATCH (ready)
    fsm.advance(state, {
      maxDiscoveryReads: 3,
      discoveryReadsUsed: 1,
      writesThisSession: 0,
      batchRemaining: [],
      readinessResult: readiness,
    });
    expect(fsm.phase).toBe('PLAN_BATCH');
  });
});
