// ─── Unit tests: AgentRunner callback type exports ────────────────────────────
//
// Verifies that all callback types introduced in the AI/UX spec (Phase 1 & 2)
// are exported from AgentRunner and have the expected shape.  These tests are
// intentionally lightweight — they exercise the *interface* contracts without
// requiring a live provider or full DI graph.

import type {
  CompactionCallback,
  PlanCreatedCallback,
  DiffSummaryCallback,
  CheckpointCreatedCallback,
  ContextUpdateCallback,
  TextCallback,
  TokenUsageCallback,
} from '../../agents/AgentRunner';
import type { ExecutionPlan } from '../../context/types';

// ─── CompactionCallback ───────────────────────────────────────────────────────

describe('CompactionCallback', () => {
  test('accepts droppedCount and preservedItems array', () => {
    const calls: [number, string[]][] = [];
    const cb: CompactionCallback = (dropped, preserved) => {
      calls.push([dropped, preserved]);
    };
    cb(5, ['objective', 'decisions']);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(5);
    expect(calls[0][1]).toEqual(['objective', 'decisions']);
  });

  test('accepts empty preservedItems', () => {
    const cb: CompactionCallback = (dropped, preserved) => {
      expect(dropped).toBe(0);
      expect(preserved).toEqual([]);
    };
    cb(0, []);
  });
});

// ─── PlanCreatedCallback ──────────────────────────────────────────────────────

describe('PlanCreatedCallback', () => {
  function makePlan(): ExecutionPlan {
    return {
      id: 'plan-001',
      objective: 'Add authentication',
      milestones: [
        { id: 'm1', title: 'Design schema', tasks: ['Create ERD'], validations: ['Schema reviewed'], status: 'todo' },
      ],
      decisions: ['Use JWT'],
      blockers: [],
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
    };
  }

  test('receives full ExecutionPlan object', () => {
    const received: ExecutionPlan[] = [];
    const cb: PlanCreatedCallback = (plan) => received.push(plan);
    cb(makePlan());
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('plan-001');
    expect(received[0].milestones).toHaveLength(1);
  });

  test('plan objective is accessible', () => {
    const cb: PlanCreatedCallback = (plan) => {
      expect(plan.objective).toBe('Add authentication');
    };
    cb(makePlan());
  });
});

// ─── DiffSummaryCallback ──────────────────────────────────────────────────────

describe('DiffSummaryCallback', () => {
  test('accepts changedFiles, intent, and optional checkpointRef', () => {
    const calls: Parameters<DiffSummaryCallback>[] = [];
    const cb: DiffSummaryCallback = (files, intent, ref) => calls.push([files, intent, ref]);

    cb(['src/auth.ts', 'src/routes.ts'], 'Add login endpoint', 'cp-abc123');
    expect(calls[0][0]).toEqual(['src/auth.ts', 'src/routes.ts']);
    expect(calls[0][1]).toBe('Add login endpoint');
    expect(calls[0][2]).toBe('cp-abc123');
  });

  test('checkpointRef is optional', () => {
    const cb: DiffSummaryCallback = (files, intent, ref) => {
      expect(ref).toBeUndefined();
    };
    cb(['src/foo.ts', 'src/bar.ts'], 'Refactor helpers');
  });
});

// ─── CheckpointCreatedCallback ────────────────────────────────────────────────

describe('CheckpointCreatedCallback', () => {
  test('receives checkpointId, label, and changedFiles', () => {
    const cb: CheckpointCreatedCallback = (id, label, files) => {
      expect(id).toBe('cp-xyz');
      expect(label).toBe('Task start: add auth');
      expect(files).toEqual([]);
    };
    cb('cp-xyz', 'Task start: add auth', []);
  });
});

// ─── ContextUpdateCallback ────────────────────────────────────────────────────

describe('ContextUpdateCallback', () => {
  test('receives items array and tokenHealth string', () => {
    const cb: ContextUpdateCallback = (items, health) => {
      expect(Array.isArray(items)).toBe(true);
      expect(['healthy', 'busy', 'near-limit']).toContain(health);
    };
    cb(
      [
        { id: 'mode', itemType: 'mode', label: 'code', source: 'system', reasonIncluded: 'Active mode', removable: false },
        { id: 'layer:repo', itemType: 'instruction', label: 'Repo instructions', source: '.bormagi/instructions/repo.md', reasonIncluded: 'Durable instruction layer', estimatedTokens: 400, removable: true },
      ],
      'healthy',
    );
  });

  test('item with estimatedTokens is optional', () => {
    const cb: ContextUpdateCallback = (items) => {
      const modeItem = items.find(i => i.id === 'mode');
      expect(modeItem?.estimatedTokens).toBeUndefined();
    };
    cb(
      [{ id: 'mode', itemType: 'mode', label: 'ask', source: 'system', reasonIncluded: 'Active mode', removable: false }],
      'healthy',
    );
  });

  test('all three tokenHealth values are valid', () => {
    const observed: string[] = [];
    const cb: ContextUpdateCallback = (_, health) => observed.push(health);
    cb([], 'healthy');
    cb([], 'busy');
    cb([], 'near-limit');
    expect(observed).toEqual(['healthy', 'busy', 'near-limit']);
  });
});

// ─── TextCallback / TokenUsageCallback (sanity) ───────────────────────────────

describe('TextCallback', () => {
  test('receives string delta', () => {
    const deltas: string[] = [];
    const cb: TextCallback = (d) => deltas.push(d);
    cb('Hello ');
    cb('world');
    expect(deltas.join('')).toBe('Hello world');
  });
});

describe('TokenUsageCallback', () => {
  test('receives inputTokens and outputTokens', () => {
    const cb: TokenUsageCallback = (usage) => {
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(250);
    };
    cb({ inputTokens: 1000, outputTokens: 250 });
  });
});
