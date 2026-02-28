// ─── Crash/restart recovery integration tests (WF-1003) ──────────────────────────
//
// Tests for recovery when VS Code restarts mid-workflow:
//   - Child task active when parent paused
//   - Review pending when parent is waiting
//   - Blocker unresolved
//   - Approval checkpoint pending
//
// Run with: npx jest src/workflow/tests/restart-recovery.test.ts

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WorkflowStorage } from '../WorkflowStorage';
import { WorkflowEngine } from '../WorkflowEngine';
import { ExecutionLock } from '../ExecutionLock';
import { ArtifactRegistry } from '../ArtifactRegistry';
import { TransitionValidator } from '../TransitionValidator';
import { BlockerTracker } from '../BlockerTracker';
import { ReviewManager } from '../ReviewManager';
import { WorkflowStatus, TaskStatus, BlockerSeverity } from '../enums';
import type { WorkflowTemplate } from '../WorkflowTemplate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-recovery-'));
}

function buildDeps(workspaceRoot: string) {
  const storage = new WorkflowStorage(workspaceRoot);
  const lock = new ExecutionLock(workspaceRoot);
  const registry = new ArtifactRegistry(storage);
  const validator = new TransitionValidator();
  const blockerTracker = new BlockerTracker(storage);
  const engine = new WorkflowEngine({ workspaceRoot, storage, lock, artifactRegistry: registry, validator, blockerTracker });
  return { storage, lock, registry, engine, blockerTracker };
}

const SIMPLE_TEMPLATE: WorkflowTemplate = {
  id: 'simple',
  name: 'Simple',
  description: 'Recovery test template.',
  version: '1.0.0',
  initialAgentId: 'agent-a',
  initialStageId: 's1',
  stages: [
    { id: 's1', name: 'Stage 1', description: '', ownerAgentId: 'agent-a',
      sequence: 1, requiredInputTypes: [], requiredOutputTypes: [],
      allowedNextStageIds: ['s2'], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
    { id: 's2', name: 'Stage 2', description: '', ownerAgentId: 'agent-b',
      sequence: 2, requiredInputTypes: [], requiredOutputTypes: [],
      allowedNextStageIds: [], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
  ],
  approvalCheckpoints: [],
  delegationRules: {},
  metadata: {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Restart recovery', () => {
  let workspaceRoot: string;

  beforeEach(() => { workspaceRoot = createTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); });

  test('WF-404: active workflow survives restart and is identified correctly', async () => {
    // Phase 1 — initial session
    const { engine: engine1, storage: storage1 } = buildDeps(workspaceRoot);
    const { workflow } = await engine1.createWorkflow({ template: SIMPLE_TEMPLATE, title: 'T', humanOwner: 'u' });
    const started = await engine1.startWorkflow(workflow.id, SIMPLE_TEMPLATE);
    const stages = await storage1.loadStages(workflow.id);
    await engine1.createAndStartTask({
      workflowId: workflow.id,
      stageId: stages[0].id,
      title: 'Task 1',
      objective: 'Do something',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    // Phase 2 — simulate restart by creating new engine on same workspace root
    const { engine: engine2 } = buildDeps(workspaceRoot);
    const result = await engine2.recoverWorkflows();

    // The lock file is fresh (< 4h old) so recoverFromDisk() restores it.
    // The workflow has an active task and a recovered lock → goes to 'recovered'.
    expect(result.recovered).toContain(workflow.id);
  });

  test('blocker still unresolved after restart', async () => {
    const { engine, storage } = buildDeps(workspaceRoot);
    const { workflow } = await engine.createWorkflow({ template: SIMPLE_TEMPLATE, title: 'Blocker Test', humanOwner: 'u' });
    await engine.startWorkflow(workflow.id, SIMPLE_TEMPLATE);

    const stages = await storage.loadStages(workflow.id);
    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: stages[0].id,
      title: 'Task',
      objective: 'Obj',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    await engine.raiseBlocker({
      workflowId: workflow.id,
      stageId: stages[0].id,
      taskId: task.id,
      raisedByAgentId: 'agent-a',
      reason: 'Need API key',
      severity: BlockerSeverity.High,
      suggestedRoute: 'Ask human',
      pauseWorkflow: false,
    });

    // Simulate restart
    const { engine: engine2, storage: storage2 } = buildDeps(workspaceRoot);
    const blockers = await storage2.loadBlockers(workflow.id);
    expect(blockers.filter(b => !b.isResolved)).toHaveLength(1);

    // Reload summary — should still show blocker
    const summary = await engine2.generateWorkflowSummary(workflow.id);
    expect(summary.activeBlockerCount).toBe(1);
  });

  test('pending review survives restart and is detectable', async () => {
    const { engine, storage } = buildDeps(workspaceRoot);
    const { workflow } = await engine.createWorkflow({ template: SIMPLE_TEMPLATE, title: 'Review Test', humanOwner: 'u' });
    await engine.startWorkflow(workflow.id, SIMPLE_TEMPLATE);

    const stages = await storage.loadStages(workflow.id);
    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: stages[0].id,
      title: 'Task',
      objective: 'Obj',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    // Create a pending review
    const reviewMgr = new ReviewManager(storage);
    await reviewMgr.requestReview(workflow.id, {
      taskId: task.id,
      requestingAgentId: 'agent-a',
      reviewerAgentId: 'agent-b',
      itemUnderReview: 'design.md',
      reviewScope: 'Full document',
      reviewCriteria: ['Meets requirements'],
      isBlocking: true,
    });

    // Simulate restart
    const { storage: storage2 } = buildDeps(workspaceRoot);
    const reviews = await storage2.loadReviews(workflow.id);
    expect(reviews.filter(r => r.status === 'pending')).toHaveLength(1);

    // Workflow summary should report pending review count
    const { engine: engine2 } = buildDeps(workspaceRoot);
    const summary = await engine2.generateWorkflowSummary(workflow.id);
    expect(summary.pendingReviewCount).toBe(1);
  });

  test('completed tasks are still completed after restart', async () => {
    const { engine, storage } = buildDeps(workspaceRoot);
    const { workflow } = await engine.createWorkflow({ template: SIMPLE_TEMPLATE, title: 'Complete Test', humanOwner: 'u' });
    await engine.startWorkflow(workflow.id, SIMPLE_TEMPLATE);

    const stages = await storage.loadStages(workflow.id);
    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: stages[0].id,
      title: 'Task',
      objective: 'Obj',
      ownerAgentId: 'agent-a',
      humanOwner: 'u',

    });

    await engine.processExecutionResult({
      taskId: task.id,
      workflowId: workflow.id,
      agentId: 'agent-a',
      outcome: 'completed',
      summary: 'Done.',
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
      completedAt: new Date().toISOString(),
    });

    // Restart
    const { storage: storage2 } = buildDeps(workspaceRoot);
    const tasks = await storage2.loadTasks(workflow.id);
    expect(tasks.find(t => t.id === task.id)?.status).toBe(TaskStatus.Completed);
  });
});
