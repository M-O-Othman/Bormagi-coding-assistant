/**
 * Integration tests for the execution engine enhancements (DD8, DD9, DD12).
 *
 * Tests verify:
 * - Context cost stays bounded over many iterations (DD8/DD12)
 * - Prompt assembly produces compact messages (DD7)
 * - Deterministic next-step synthesis works end-to-end (DD5/DD9)
 * - FileSummaryStore hash-based reuse (DD7)
 * - Recovery from blocked reads (DD6)
 * - Execution state reconciliation
 */
import { ExecutionStateManager, type ExecutionStateData } from '../../agents/ExecutionStateManager';
import { PromptAssembler, buildWorkspaceSummary } from '../../agents/execution/PromptAssembler';
import { ContextPacketBuilder } from '../../agents/execution/ContextPacketBuilder';
import { FileSummaryStore } from '../../agents/execution/FileSummaryStore';
import { ContextCostTracker } from '../../agents/execution/ContextCostTracker';
import { RecoveryManager } from '../../agents/execution/RecoveryManager';
import type { ChatMessage } from '../../types';

function makeState(overrides: Partial<ExecutionStateData> = {}): ExecutionStateData {
  return {
    version: 2,
    agentId: 'test',
    objective: 'Build an Express API',
    mode: 'code',
    workspaceRoot: '/ws',
    resolvedInputs: [],
    artifactsCreated: [],
    completedSteps: [],
    nextActions: [],
    blockers: [],
    techStack: {},
    iterationsUsed: 0,
    plannedFileBatch: [],
    completedBatchFiles: [],
    updatedAt: new Date().toISOString(),
    executedTools: [],
    ...overrides,
  } as ExecutionStateData;
}

const makeAssembler = () => new PromptAssembler({
  executionStateHeader: '[Execution State]',
  workspaceHeader: '[Workspace]',
  milestoneSummaryPrefix: 'Prior milestone: ',
});

describe('Context cost bounded over iterations (DD8 + DD12)', () => {
  test('prompt assembly size stays bounded regardless of iteration count', () => {
    const assembler = makeAssembler();
    const builder = new ContextPacketBuilder();
    const tracker = new ContextCostTracker();
    const system = 'You are an expert coder. Build the requested project.';

    // Simulate 10 iterations — each should produce bounded-size messages
    const tokenCounts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const state = makeState({
        iterationsUsed: i,
        artifactsCreated: Array.from({ length: i }, (_, j) => `src/file${j}.ts`),
        plannedFileBatch: ['src/file0.ts', 'src/file1.ts', 'src/file2.ts'],
        completedBatchFiles: Array.from({ length: Math.min(i, 3) }, (_, j) => `src/file${j}.ts`),
        lastExecutedTool: 'write_file',
      });
      const packet = builder.build(state, 'scaffolded');
      const msgs = assembler.assembleMessages({
        systemPrompt: system,
        executionStateSummary: packet.stateSummary,
        workspaceSummary: packet.workspaceSummary,
        currentInstruction: `Write file ${i}`,
        currentStepToolResults: [],
      });
      const totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
      tokenCounts.push(totalChars);

      tracker.record(i, system, packet.stateSummary, packet.workspaceSummary, '', `Write file ${i}`, '');
    }

    // All iterations should produce roughly similar size (no unbounded growth)
    const maxChars = Math.max(...tokenCounts);
    const minChars = Math.min(...tokenCounts);
    // Allow up to 2x variance for artifact list growth
    expect(maxChars / minChars).toBeLessThan(2);
    // Should all be under 4000 chars (compact)
    expect(maxChars).toBeLessThan(4000);

    // Cost tracker should have recorded all turns
    const summary = tracker.getSummary();
    expect(summary.totalTurns).toBe(10);
    expect(summary.avgTokensPerTurn).toBeGreaterThan(0);
  });
});

describe('FileSummaryStore hash-based reuse (DD7)', () => {
  test('same content returns cached summary, different content returns null', () => {
    const store = new FileSummaryStore();
    const content1 = 'export function hello() { return "world"; }';
    const content2 = 'export function hello() { return "updated"; }';

    // First read — store summary
    store.put('src/hello.ts', content1, 'Hello function module');

    // Same content → returns cached
    const hash1 = FileSummaryStore.hashContent(content1);
    const cached = store.get('src/hello.ts', hash1);
    expect(cached).not.toBeNull();
    expect(cached!.summary).toBe('Hello function module');

    // Different content → returns null (stale)
    const hash2 = FileSummaryStore.hashContent(content2);
    expect(store.get('src/hello.ts', hash2)).toBeNull();

    // Update with new content
    store.put('src/hello.ts', content2, 'Updated hello module');
    const updated = store.get('src/hello.ts', hash2);
    expect(updated).not.toBeNull();
    expect(updated!.summary).toBe('Updated hello module');
  });
});

describe('Execution state reconciliation', () => {
  const mgr = new ExecutionStateManager('/tmp/test');

  test('reconcileWithUserMessage resets counters on new message', () => {
    const state = makeState({
      blockedReadCount: 5,
      continueCount: 3,
      sameToolLoop: { tool: 'read_file', path: 'x.ts', count: 4 },
      nextActions: ['old action'],
    });
    mgr.reconcileWithUserMessage(state, 'Write a new feature', 'code');
    expect(state.blockedReadCount).toBe(0);
    expect(state.continueCount).toBe(0);
    expect(state.sameToolLoop).toBeUndefined();
    expect(state.objective).toContain('Write a new feature');
  });

  test('reconcileWithUserMessage preserves artifacts on continue', () => {
    const state = makeState({
      artifactsCreated: ['pkg.json', 'src/index.ts'],
      resolvedInputs: ['plan.md'],
    });
    mgr.reconcileWithUserMessage(state, 'continue', 'code');
    expect(state.artifactsCreated).toEqual(['pkg.json', 'src/index.ts']);
    expect(state.resolvedInputs).toEqual(['plan.md']);
  });
});

describe('Recovery from blocked reads (DD6)', () => {
  test('recovery uses deterministic next step when available', () => {
    const state = makeState({
      blockedReadCount: 4,
      plannedFileBatch: ['a.ts', 'b.ts'],
      completedBatchFiles: ['a.ts'],
    });
    const systemPrompt = 'You are a coder.';
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Build the project' },
    ];
    const assembler = makeAssembler();
    const stateManager = new ExecutionStateManager('/tmp/test');
    const recovery = new RecoveryManager(state, messages, assembler, systemPrompt, 'scaffolded', stateManager);

    const trigger = recovery.shouldRecover();
    expect(trigger).toBe('REPEATED_BLOCKED_READS');

    const result = recovery.rebuild(trigger!);
    expect(result.success).toBe(true);
    expect(result.cleanMessages).toBeDefined();
    // Clean messages should be compact
    if (result.cleanMessages) {
      const totalChars = result.cleanMessages.reduce((sum, m) => sum + m.content.length, 0);
      expect(totalChars).toBeLessThan(5000);
    }
  });
});

describe('ContextPacketBuilder compact output (DD7)', () => {
  test('packet with large state still produces bounded output', () => {
    const builder = new ContextPacketBuilder();
    const state = makeState({
      objective: 'A'.repeat(1000), // very long objective
      artifactsCreated: Array.from({ length: 20 }, (_, i) => `src/module${i}.ts`),
      plannedFileBatch: Array.from({ length: 20 }, (_, i) => `src/module${i}.ts`),
      completedBatchFiles: Array.from({ length: 15 }, (_, i) => `src/module${i}.ts`),
      techStack: { a: 'x', b: 'y', c: 'z' },
      resolvedInputSummaries: Array.from({ length: 10 }, (_, i) => ({
        path: `src/file${i}.ts`, hash: `h${i}`, summary: `Summary ${i}`, kind: 'source' as const, lastReadAt: '',
      })),
    });
    const packet = builder.build(state, 'mature');
    // Objective truncated to 200 chars
    expect(packet.stateSummary.length).toBeLessThan(1500);
    // Only last 3 resolved input summaries
    expect(packet.resolvedInputSummaries).toHaveLength(3);
    // Estimated tokens should be reasonable
    expect(packet.estimatedTokens).toBeLessThan(500);
  });
});

describe('Prompt assembly with tool results (DD8)', () => {
  test('tool results from current step included, prior iterations excluded', () => {
    const assembler = makeAssembler();

    const toolResult: ChatMessage = {
      role: 'tool_result',
      content: 'File written: src/index.ts',
      toolCallId: 'tr-1',
    };

    const msgs = assembler.assembleMessages({
      systemPrompt: 'System',
      executionStateSummary: 'State',
      workspaceSummary: 'Workspace',
      currentInstruction: 'Write next file',
      currentStepToolResults: [toolResult],
    });

    // Should contain the tool result
    const hasToolResult = msgs.some(m => m.content.includes('File written: src/index.ts'));
    expect(hasToolResult).toBe(true);

    // Should NOT contain any prior assistant turns (0 history replay)
    const assistantTurns = msgs.filter(m => m.role === 'assistant');
    // Only milestone summary would be assistant role, and we didn't set one
    expect(assistantTurns).toHaveLength(0);
  });
});
