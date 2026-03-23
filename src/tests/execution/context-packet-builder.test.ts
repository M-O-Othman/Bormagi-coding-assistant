/**
 * Tests for DD7: ContextPacketBuilder — compact context packets from execution state.
 */
import { ContextPacketBuilder } from '../../agents/execution/ContextPacketBuilder';
import type { ExecutionStateData } from '../../agents/ExecutionStateManager';

const makeState = (overrides: Partial<ExecutionStateData> = {}): ExecutionStateData => ({
  version: 2,
  agentId: 'test-agent',
  objective: 'Build an Express API server',
  mode: 'code',
  workspaceRoot: '/tmp/test',
  iterationsUsed: 3,
  updatedAt: '2026-03-15T00:01:00.000Z',
  completedSteps: ['Read spec', 'Planned architecture'],
  nextActions: ['Write src/index.ts'],
  blockers: [],
  techStack: { runtime: 'node', framework: 'express' },
  artifactsCreated: ['package.json', 'tsconfig.json'],
  resolvedInputs: [],
  executedTools: [],
  lastExecutedTool: 'write_file',
  plannedFileBatch: ['src/index.ts', 'src/routes.ts', 'src/middleware.ts'],
  completedBatchFiles: ['package.json'],
  ...overrides,
} as ExecutionStateData);

describe('ContextPacketBuilder', () => {
  const builder = new ContextPacketBuilder();

  test('build() returns stateSummary containing objective', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.stateSummary).toContain('Build an Express API server');
  });

  test('build() includes mode and iterations in summary', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.stateSummary).toContain('code');
    expect(result.stateSummary).toContain('3');
  });

  test('build() includes tech stack when present', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.stateSummary).toContain('express');
  });

  test('build() includes artifacts created', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.stateSummary).toContain('package.json');
  });

  test('build() includes next action', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.stateSummary).toContain('Write src/index.ts');
  });

  test('build() includes batch remaining files', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.stateSummary).toContain('Batch remaining');
    expect(result.stateSummary).toContain('src/index.ts');
  });

  test('build() returns workspace summary for greenfield (empty)', () => {
    const result = builder.build(makeState({ artifactsCreated: [] }), 'greenfield');
    expect(result.workspaceSummary.toLowerCase()).toContain('greenfield');
  });

  test('build() returns workspace summary for mature', () => {
    const result = builder.build(makeState(), 'mature');
    expect(result.workspaceSummary.toLowerCase()).toContain('mature');
  });

  test('build() includes estimated tokens', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test('build() includes nextAction from state', () => {
    const result = builder.build(makeState(), 'scaffolded');
    expect(result.nextAction).toBe('Write src/index.ts');
  });

  test('build() handles empty state gracefully', () => {
    const emptyState = makeState({
      objective: 'Test',
      nextActions: [],
      techStack: {},
      artifactsCreated: [],
      plannedFileBatch: [],
      completedBatchFiles: [],
    });
    const result = builder.build(emptyState, 'greenfield');
    expect(result.stateSummary).toContain('Test');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test('build() truncates long objectives to 200 chars', () => {
    const longObj = 'x'.repeat(500);
    const result = builder.build(makeState({ objective: longObj }), 'mature');
    // The objective line should not be the full 500 chars
    expect(result.stateSummary.length).toBeLessThan(500 + 200);
  });

  test('build() includes approved plan path when present', () => {
    const result = builder.build(
      makeState({ approvedPlanPath: '.bormagi/plans/my-plan.md' }),
      'scaffolded',
    );
    expect(result.stateSummary).toContain('.bormagi/plans/my-plan.md');
  });

  test('build() includes nextToolCall description when present', () => {
    const state = makeState({
      nextToolCall: { tool: 'write_file', input: { path: 'src/index.ts' }, description: 'Write entry point' },
    });
    const result = builder.build(state, 'scaffolded');
    expect(result.nextToolCallDescription).toBe('Write entry point');
  });

  test('build() resolved input summaries limited to 3', () => {
    const state = makeState({
      resolvedInputSummaries: [
        { path: 'a.ts', hash: 'h1', summary: 'A', kind: 'source', lastReadAt: '' },
        { path: 'b.ts', hash: 'h2', summary: 'B', kind: 'source', lastReadAt: '' },
        { path: 'c.ts', hash: 'h3', summary: 'C', kind: 'source', lastReadAt: '' },
        { path: 'd.ts', hash: 'h4', summary: 'D', kind: 'source', lastReadAt: '' },
      ],
    });
    const result = builder.build(state, 'scaffolded');
    expect(result.resolvedInputSummaries).toHaveLength(3);
  });
});
