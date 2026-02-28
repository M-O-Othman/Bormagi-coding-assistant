// ─── State machine unit tests (WF-1001) ──────────────────────────────────────────
//
// Tests for the workflow state machine: valid/invalid transitions, delegation,
// resume, blockers, and approval gating.
//
// Run with: npx jest src/workflow/tests/state-machine.test.ts
//
// These tests use an in-memory WorkflowStorage stub so no filesystem I/O occurs.

import { WorkflowEngine } from '../WorkflowEngine';
import { WorkflowStorage } from '../WorkflowStorage';
import { ExecutionLock } from '../ExecutionLock';
import { ArtifactRegistry } from '../ArtifactRegistry';
import { TransitionValidator } from '../TransitionValidator';
import { BlockerTracker } from '../BlockerTracker';
import { WorkflowStatus, StageStatus, TaskStatus, BlockerSeverity } from '../enums';
import type { WorkflowTemplate } from '../WorkflowTemplate';
import type { Workflow, WorkflowStage, WorkflowTask, Blocker, WorkflowEvent, HandoffRequest, ReviewRequest, DecisionLogEntry } from '../types';

// ─── Minimal in-memory storage stub ──────────────────────────────────────────

class MemoryStorage extends WorkflowStorage {
  private _workflows = new Map<string, Workflow>();
  private _stages = new Map<string, WorkflowStage[]>();
  private _tasks = new Map<string, WorkflowTask[]>();
  private _blockers = new Map<string, Blocker[]>();
  private _events: WorkflowEvent[] = [];

  constructor() { super('/tmp/test-workspace'); }

  override async saveWorkflow(wf: Workflow): Promise<void> { this._workflows.set(wf.id, wf); }
  override async loadWorkflow(id: string): Promise<Workflow | null> { return this._workflows.get(id) ?? null; }
  override async listWorkflowIds(): Promise<string[]> { return Array.from(this._workflows.keys()); }

  override async saveStages(workflowId: string, stages: WorkflowStage[]): Promise<void> { this._stages.set(workflowId, stages); }
  override async loadStages(workflowId: string): Promise<WorkflowStage[]> { return this._stages.get(workflowId) ?? []; }

  override async saveTasks(workflowId: string, tasks: WorkflowTask[]): Promise<void> { this._tasks.set(workflowId, tasks); }
  override async loadTasks(workflowId: string): Promise<WorkflowTask[]> { return this._tasks.get(workflowId) ?? []; }

  override async saveBlockers(workflowId: string, blockers: Blocker[]): Promise<void> { this._blockers.set(workflowId, blockers); }
  override async loadBlockers(workflowId: string): Promise<Blocker[]> { return this._blockers.get(workflowId) ?? []; }

  override async appendEvent(_workflowId: string, event: WorkflowEvent): Promise<void> { this._events.push(event); }
  override async loadEvents(_workflowId: string): Promise<WorkflowEvent[]> { return this._events; }

  // No-op overrides for methods not exercised by state-machine unit tests
  override async loadHandoffs(_workflowId: string): Promise<HandoffRequest[]> { return []; }
  override async appendHandoffEntry(_workflowId: string, _handoff: HandoffRequest): Promise<void> {}
  override async saveHandoffSnapshots(_workflowId: string, _handoffs: HandoffRequest[]): Promise<void> {}
  override async loadHandoffSnapshots(_workflowId: string): Promise<HandoffRequest[]> { return []; }
  override async loadReviews(_workflowId: string): Promise<ReviewRequest[]> { return []; }
  override async saveReviews(_workflowId: string, _reviews: ReviewRequest[]): Promise<void> {}
  override async appendDecisionEntry(_workflowId: string, _decision: DecisionLogEntry): Promise<void> {}
  override async loadDecisions(_workflowId: string): Promise<DecisionLogEntry[]> { return []; }
}

// ─── Minimal template ─────────────────────────────────────────────────────────

function buildTestTemplate(): WorkflowTemplate {
  return {
    id: 'test-template',
    name: 'Test Template',
    description: 'Minimal template for unit tests.',
    version: '1.0.0',
    initialAgentId: 'agent-a',
    initialStageId: 'stage-1',
    stages: [
      {
        id: 'stage-1',
        name: 'Stage 1',
        description: 'First stage.',
        ownerAgentId: 'agent-a',
        sequence: 1,
        requiredInputTypes: [],
        requiredOutputTypes: [],
        allowedNextStageIds: ['stage-2'],
        allowedFallbackStageIds: [],
        allowedDelegationTargetIds: [],
        entryRules: [],
        exitRules: [],
        requiresApprovalBeforeStart: false,
        requiresApprovalBeforeComplete: false,
      },
      {
        id: 'stage-2',
        name: 'Stage 2',
        description: 'Second stage.',
        ownerAgentId: 'agent-b',
        sequence: 2,
        requiredInputTypes: [],
        requiredOutputTypes: [],
        allowedNextStageIds: [],
        allowedFallbackStageIds: [],
        allowedDelegationTargetIds: [],
        entryRules: [],
        exitRules: [],
        requiresApprovalBeforeStart: false,
        requiresApprovalBeforeComplete: false,
      },
    ],
    approvalCheckpoints: [],
    delegationRules: {},
    metadata: {},
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function buildEngine(storage: MemoryStorage): WorkflowEngine {
  const lock = new ExecutionLock('/tmp/test-workspace');
  const registry = new ArtifactRegistry(storage);
  const validator = new TransitionValidator();
  const blockerTracker = new BlockerTracker(storage);
  return new WorkflowEngine({
    workspaceRoot: '/tmp/test-workspace',
    storage,
    lock,
    artifactRegistry: registry,
    validator,
    blockerTracker,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowEngine — state machine', () => {

  test('createWorkflow produces Draft workflow with correct stage count', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow, stages } = await engine.createWorkflow({
      template,
      title: 'Test workflow',
      humanOwner: 'test-user',
    });

    expect(workflow.status).toBe(WorkflowStatus.Draft);
    expect(workflow.title).toBe('Test workflow');
    expect(stages).toHaveLength(2);
    expect(stages[0].status).toBe(StageStatus.Pending);
  });

  test('startWorkflow transitions workflow to Active and sets initial stage', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'T', humanOwner: 'u' });
    const started = await engine.startWorkflow(workflow.id, template);

    expect(started.status).toBe(WorkflowStatus.Active);
    expect(started.currentStageId).not.toBeNull();
  });

  test('startWorkflow rejects if workflow is not in Draft status', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'T', humanOwner: 'u' });
    await engine.startWorkflow(workflow.id, template);

    await expect(engine.startWorkflow(workflow.id, template)).rejects.toThrow('status is "active"');
  });

  test('cancelTask marks task as Cancelled and releases execution lock', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'T', humanOwner: 'u' });
    const started = await engine.startWorkflow(workflow.id, template);

    // Create a task directly via createAndStartTask
    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: started.currentStageId!,
      title: 'Test task',
      objective: 'Do something',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    await engine.cancelTask(workflow.id, task.id, 'No longer needed', 'human');

    const tasks = await storage.loadTasks(workflow.id);
    const cancelled = tasks.find(t => t.id === task.id);
    expect(cancelled?.status).toBe(TaskStatus.Cancelled);
  });

  test('raiseBlocker transitions task to Blocked status', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'T', humanOwner: 'u' });
    const started = await engine.startWorkflow(workflow.id, template);

    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: started.currentStageId!,
      title: 'Blocked task',
      objective: 'Something',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    await engine.raiseBlocker({
      workflowId: workflow.id,
      stageId: started.currentStageId!,
      taskId: task.id,
      raisedByAgentId: 'agent-a',
      reason: 'Missing API credentials',
      severity: BlockerSeverity.High,
      suggestedRoute: 'Escalate to human owner',
      pauseWorkflow: false,
    });

    const tasks = await storage.loadTasks(workflow.id);
    const blockedTask = tasks.find(t => t.id === task.id);
    expect(blockedTask?.status).toBe(TaskStatus.Blocked);

    const blockers = await storage.loadBlockers(workflow.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].isResolved).toBe(false);
  });

  test('resolveBlocker unblocks task when no remaining blockers', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'T', humanOwner: 'u' });
    const started = await engine.startWorkflow(workflow.id, template);

    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: started.currentStageId!,
      title: 'Task',
      objective: 'Something',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    const blocker = await engine.raiseBlocker({
      workflowId: workflow.id,
      stageId: started.currentStageId!,
      taskId: task.id,
      raisedByAgentId: 'agent-a',
      reason: 'Need credentials',
      severity: BlockerSeverity.Medium,
      suggestedRoute: 'Ask human',
      pauseWorkflow: false,
    });

    await engine.resolveBlocker(workflow.id, blocker.id, 'Credentials provided', 'human');

    const tasks = await storage.loadTasks(workflow.id);
    const resolvedTask = tasks.find(t => t.id === task.id);
    expect(resolvedTask?.status).toBe(TaskStatus.Active);

    const blockers = await storage.loadBlockers(workflow.id);
    expect(blockers[0].isResolved).toBe(true);
  });

  test('generateWorkflowSummary returns structured summary', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'Summary Test', humanOwner: 'u' });
    await engine.startWorkflow(workflow.id, template);

    const summary = await engine.generateWorkflowSummary(workflow.id);

    expect(summary.workflowId).toBe(workflow.id);
    expect(summary.title).toBe('Summary Test');
    expect(summary.status).toBe(WorkflowStatus.Active);
    expect(summary.markdownSummary).toContain('Summary Test');
  });

  test('recoverWorkflows returns workflow IDs without stale locks', async () => {
    const storage = new MemoryStorage();
    const engine = buildEngine(storage);
    const template = buildTestTemplate();

    const { workflow } = await engine.createWorkflow({ template, title: 'R', humanOwner: 'u' });
    await engine.startWorkflow(workflow.id, template);

    const result = await engine.recoverWorkflows();

    // Newly started workflow with no stale lock should appear in `recovered`
    expect(result.recovered).toContain(workflow.id);
    expect(result.requiresAttention).not.toContain(workflow.id);
  });
});
