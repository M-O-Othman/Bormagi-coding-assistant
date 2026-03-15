/**
 * Tests for DD12: ContextCostTracker — per-turn context cost telemetry.
 */
import { ContextCostTracker } from '../../agents/execution/ContextCostTracker';

describe('ContextCostTracker', () => {
  test('record() returns entry with correct token estimates', () => {
    const tracker = new ContextCostTracker();
    const entry = tracker.record(
      0,
      'system prompt text here',       // ~6 tokens
      'execution state',               // ~4 tokens
      'workspace summary',             // ~4 tokens
      '',                              // no skill fragments
      'Write package.json',            // ~4 tokens
      'File written: package.json',    // ~6 tokens
    );
    expect(entry.turn).toBe(0);
    expect(entry.systemPromptTokens).toBeGreaterThan(0);
    expect(entry.executionStateTokens).toBeGreaterThan(0);
    expect(entry.totalTokens).toBe(
      entry.systemPromptTokens +
      entry.executionStateTokens +
      entry.workspaceSummaryTokens +
      entry.skillFragmentTokens +
      entry.currentInstructionTokens +
      entry.toolResultTokens
    );
    expect(entry.timestamp).toBeTruthy();
  });

  test('getEntries() returns all recorded entries', () => {
    const tracker = new ContextCostTracker();
    tracker.record(0, 'sys', 'exec', 'ws', '', 'inst', 'result');
    tracker.record(1, 'sys', 'exec2', 'ws2', '', 'inst2', 'result2');
    expect(tracker.getEntries()).toHaveLength(2);
  });

  test('getSummary() computes correct aggregates', () => {
    const tracker = new ContextCostTracker();
    tracker.record(0, 'a'.repeat(100), 'b', 'c', '', 'd', 'e');
    tracker.record(1, 'f'.repeat(200), 'g', 'h', '', 'i', 'j');
    const summary = tracker.getSummary();
    expect(summary.totalTurns).toBe(2);
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.avgTokensPerTurn).toBe(Math.round(summary.totalTokens / 2));
  });

  test('recordSkippedLLMCall() increments counter in subsequent entries', () => {
    const tracker = new ContextCostTracker();
    tracker.recordSkippedLLMCall();
    tracker.recordSkippedLLMCall();
    const entry = tracker.record(0, 'sys', 'exec', 'ws', '', 'inst', 'res');
    expect(entry.llmCallsSkipped).toBe(2);
    expect(tracker.getSummary().llmCallsSkipped).toBe(2);
  });

  test('recordSummaryReuse() increments counter in subsequent entries', () => {
    const tracker = new ContextCostTracker();
    tracker.recordSummaryReuse();
    const entry = tracker.record(0, 'sys', 'exec', 'ws', '', 'inst', 'res');
    expect(entry.resolvedSummariesReused).toBe(1);
  });

  test('recordRawFileInjection() increments counter in subsequent entries', () => {
    const tracker = new ContextCostTracker();
    tracker.recordRawFileInjection();
    tracker.recordRawFileInjection();
    tracker.recordRawFileInjection();
    const entry = tracker.record(0, 'sys', 'exec', 'ws', '', 'inst', 'res');
    expect(entry.rawFileContentsInjected).toBe(3);
  });

  test('getSummary() with no entries returns zeroes', () => {
    const tracker = new ContextCostTracker();
    const summary = tracker.getSummary();
    expect(summary.totalTurns).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.avgTokensPerTurn).toBe(0);
    expect(summary.llmCallsSkipped).toBe(0);
  });

  test('getEntries() returns copies, not references', () => {
    const tracker = new ContextCostTracker();
    tracker.record(0, 'sys', 'exec', 'ws', '', 'inst', 'res');
    const entries1 = tracker.getEntries();
    const entries2 = tracker.getEntries();
    expect(entries1).not.toBe(entries2);
    expect(entries1).toEqual(entries2);
  });
});
