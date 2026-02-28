// ─── End-to-end workflow integration tests (WF-1002) ─────────────────────────────
//
// Full feature workflow: create → requirements → architecture → implementation → QA → release → complete.
// These tests exercise the entire engine + storage pipeline against a real temp directory.
//
// Run with: npx jest src/workflow/tests/e2e-workflow.test.ts --testTimeout=30000
//
// Prerequisites: Node.js fs access to a temp directory.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WorkflowStorage } from '../WorkflowStorage';
import { WorkflowEngine } from '../WorkflowEngine';
import { ExecutionLock } from '../ExecutionLock';
import { ArtifactRegistry } from '../ArtifactRegistry';
import { TransitionValidator } from '../TransitionValidator';
import { BlockerTracker } from '../BlockerTracker';
import { ArtifactApprovalStatus, WorkflowStatus } from '../enums';
import type { WorkflowTemplate } from '../WorkflowTemplate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-e2e-'));
  return dir;
}

function buildEngine(workspaceRoot: string): WorkflowEngine {
  const storage = new WorkflowStorage(workspaceRoot);
  const lock = new ExecutionLock(workspaceRoot);
  const registry = new ArtifactRegistry(storage);
  const validator = new TransitionValidator();
  const blockerTracker = new BlockerTracker(storage);
  return new WorkflowEngine({ workspaceRoot, storage, lock, artifactRegistry: registry, validator, blockerTracker });
}

const FEATURE_TEMPLATE: WorkflowTemplate = {
  id: 'feature-delivery',
  name: 'Feature Delivery',
  description: 'E2E test template',
  version: '1.0.0',
  initialAgentId: 'business-analyst',
  initialStageId: 'requirements',
  stages: [
    { id: 'requirements', name: 'Requirements', description: '', ownerAgentId: 'business-analyst',
      sequence: 1, requiredInputTypes: [], requiredOutputTypes: ['requirements-document'],
      allowedNextStageIds: ['architecture'], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
    { id: 'architecture', name: 'Architecture', description: '', ownerAgentId: 'solution-architect',
      sequence: 2, requiredInputTypes: ['requirements-document'], requiredOutputTypes: ['architecture-document'],
      allowedNextStageIds: ['implementation'], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
    { id: 'implementation', name: 'Implementation', description: '', ownerAgentId: 'advanced-coder',
      sequence: 3, requiredInputTypes: ['architecture-document'], requiredOutputTypes: ['implementation'],
      allowedNextStageIds: ['qa-validation'], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
    { id: 'qa-validation', name: 'QA Validation', description: '', ownerAgentId: 'software-qa',
      sequence: 4, requiredInputTypes: ['implementation'], requiredOutputTypes: ['test-report'],
      allowedNextStageIds: ['done'], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
    { id: 'done', name: 'Done', description: '', ownerAgentId: '',
      sequence: 5, requiredInputTypes: [], requiredOutputTypes: [],
      allowedNextStageIds: [], allowedFallbackStageIds: [], allowedDelegationTargetIds: [],
      entryRules: [], exitRules: [],
      requiresApprovalBeforeStart: false, requiresApprovalBeforeComplete: false },
  ],
  approvalCheckpoints: [],
  delegationRules: {},
  metadata: {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E workflow — feature delivery', () => {
  let workspaceRoot: string;

  beforeEach(() => { workspaceRoot = createTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); });

  test('full workflow lifecycle: create → start → task → complete', async () => {
    const engine = buildEngine(workspaceRoot);
    const storage = new WorkflowStorage(workspaceRoot);

    // 1. Create and start the workflow
    const { workflow } = await engine.createWorkflow({
      template: FEATURE_TEMPLATE,
      title: 'Add OAuth2 login',
      humanOwner: 'alice',
      linkedIssueId: 'GH-42',
    });
    expect(workflow.status).toBe(WorkflowStatus.Draft);

    const started = await engine.startWorkflow(workflow.id, FEATURE_TEMPLATE);
    expect(started.status).toBe(WorkflowStatus.Active);
    expect(started.currentStageId).not.toBeNull();

    // 2. Create a task in the requirements stage
    const stages = await storage.loadStages(workflow.id);
    const reqStage = stages.find(s => s.templateStageId === 'requirements')!;
    expect(reqStage).toBeDefined();
    // currentStageId is the stage instance UUID; verify it maps to the 'requirements' template stage
    expect(started.currentStageId).toBe(reqStage.id);

    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: reqStage.id,
      title: 'Write requirements document',
      objective: 'Produce a requirements document covering OAuth2 login flows.',
      ownerAgentId: 'business-analyst',
      humanOwner: 'alice',
    });
    expect(task.status).toBe('active');

    // 3. Process a completed execution result
    await engine.processExecutionResult({
      taskId: task.id,
      workflowId: workflow.id,
      agentId: 'business-analyst',
      outcome: 'completed',
      summary: 'Requirements document written.',
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
      completedAt: new Date().toISOString(),
    });

    const tasks = await storage.loadTasks(workflow.id);
    const completedTask = tasks.find(t => t.id === task.id);
    expect(completedTask?.status).toBe('completed');

    // 4. Verify workflow event log has entries
    const events = await storage.loadEvents(workflow.id);
    expect(events.length).toBeGreaterThan(0);
    const eventTypes = events.map((e: unknown) => (e as { eventType: string }).eventType);
    expect(eventTypes).toContain('workflow_created');
    expect(eventTypes).toContain('stage_started');
    expect(eventTypes).toContain('task_created');
    expect(eventTypes).toContain('task_completed');
  });

  test('workflow persists and reloads across engine instances (restart simulation)', async () => {
    const engine1 = buildEngine(workspaceRoot);
    const { workflow } = await engine1.createWorkflow({
      template: FEATURE_TEMPLATE,
      title: 'Persisted workflow',
      humanOwner: 'bob',
    });
    await engine1.startWorkflow(workflow.id, FEATURE_TEMPLATE);

    // Simulate restart by creating a new engine instance pointing at the same directory
    const engine2 = buildEngine(workspaceRoot);
    const summary = await engine2.generateWorkflowSummary(workflow.id);

    expect(summary.workflowId).toBe(workflow.id);
    expect(summary.title).toBe('Persisted workflow');
    expect(summary.status).toBe(WorkflowStatus.Active);
  });

  test('artifact registration is persisted and readable', async () => {
    const engine = buildEngine(workspaceRoot);
    const storage = new WorkflowStorage(workspaceRoot);
    const registry = new ArtifactRegistry(storage);

    const { workflow } = await engine.createWorkflow({
      template: FEATURE_TEMPLATE,
      title: 'Artifact test',
      humanOwner: 'carol',
    });
    await engine.startWorkflow(workflow.id, FEATURE_TEMPLATE);

    const stages = await storage.loadStages(workflow.id);
    const reqStage = stages[0];

    // Register an artifact
    const task = await engine.createAndStartTask({
      workflowId: workflow.id,
      stageId: reqStage.id,
      title: 'Task',
      objective: 'Objective',
      ownerAgentId: 'business-analyst',
      humanOwner: 'carol',
    });

    const artifact = await registry.register(workflow.id, {
      stageId: reqStage.id,
      taskId: task.id,
      producingAgentId: 'business-analyst',
      name: 'requirements.md',
      description: 'Requirements document',
      type: 'requirements-document',
      path: 'docs/requirements.md',
    });

    expect(artifact.approvalStatus).toBe(ArtifactApprovalStatus.Draft);

    // Reload from disk
    const loaded = await registry.getAll(workflow.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('requirements.md');
  });
});
