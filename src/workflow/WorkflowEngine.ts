// ─── Workflow engine (WF-101) ───────────────────────────────────────────────────
//
// Central orchestration service. Responsibilities:
//   - Create workflow instances from templates.
//   - Track the current stage and active task.
//   - Enforce one active agent at a time (via ExecutionLock).
//   - Move through valid stages only (via TransitionValidator).
//   - Persist all state changes via WorkflowStorage.
//   - Emit structured WorkflowEvents for every state change.

import { randomUUID as uuidv4 } from 'crypto';
import { WorkflowStatus, StageStatus, TaskStatus, ExecutionOutcome, BlockerSeverity, ReviewStatus } from './enums';
import { ExecutionLock } from './ExecutionLock';
import { ArtifactRegistry } from './ArtifactRegistry';
import { TransitionValidator } from './TransitionValidator';
import { WorkflowStorage } from './WorkflowStorage';
import { BlockerTracker } from './BlockerTracker';
import type { WorkflowTemplate, StageTemplate } from './WorkflowTemplate';
import type {
  Workflow,
  WorkflowStage,
  WorkflowTask,
  HandoffRequest,
  Blocker,
  WorkflowEvent,
  AgentExecutionResult,
  ValidationResult,
} from './types';

export interface WorkflowEngineOptions {
  workspaceRoot: string;
  storage: WorkflowStorage;
  lock: ExecutionLock;
  artifactRegistry: ArtifactRegistry;
  validator: TransitionValidator;
  blockerTracker: BlockerTracker;
}

export class WorkflowEngine {
  private readonly storage: WorkflowStorage;
  private readonly lock: ExecutionLock;
  private readonly artifactRegistry: ArtifactRegistry;
  private readonly validator: TransitionValidator;
  private readonly blockerTracker: BlockerTracker;

  /** In-memory cache of granted approval checkpoint IDs. Key = workflowId. */
  private readonly grantedApprovals = new Map<string, Set<string>>();

  constructor(private readonly opts: WorkflowEngineOptions) {
    this.storage         = opts.storage;
    this.lock            = opts.lock;
    this.artifactRegistry = opts.artifactRegistry;
    this.validator       = opts.validator;
    this.blockerTracker  = opts.blockerTracker;
  }

  // ─── Workflow lifecycle ───────────────────────────────────────────────────────

  /**
   * Create a new workflow instance from a template.
   * Sets the workflow to Draft status and prepares the first stage.
   */
  async createWorkflow(params: {
    template: WorkflowTemplate;
    title: string;
    humanOwner: string;
    linkedIssueId?: string;
  }): Promise<{ workflow: Workflow; stages: WorkflowStage[] }> {
    const now = new Date().toISOString();
    const workflowId = uuidv4();

    const workflow: Workflow = {
      id: workflowId,
      title: params.title,
      templateId: params.template.id,
      status: WorkflowStatus.Draft,
      humanOwner: params.humanOwner,
      currentStageId: null,
      activeTaskId: null,
      workspaceRoot: this.opts.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      linkedIssueId: params.linkedIssueId ?? null,
      metadata: {},
    };

    // Build WorkflowStage instances from the template.
    const stages: WorkflowStage[] = params.template.stages.map(st => this.buildStage(workflowId, st, now));

    await this.storage.saveWorkflow(workflow);
    await this.storage.saveStages(workflowId, stages);
    await this.emitEvent(workflow.id, null, null, null, 'workflow_created', { title: params.title, templateId: params.template.id });

    return { workflow, stages };
  }

  /**
   * Transition a workflow from Draft to Active and start the initial stage.
   * Validates the initial stage entry before proceeding.
   */
  async startWorkflow(workflowId: string, template: WorkflowTemplate): Promise<Workflow> {
    const workflow = await this.requireWorkflow(workflowId);
    if (workflow.status !== WorkflowStatus.Draft) {
      throw new Error(`Cannot start workflow "${workflowId}": status is "${workflow.status}", expected "draft".`);
    }

    const stages = await this.storage.loadStages(workflowId);
    const initialStage = stages.find(s => s.templateStageId === template.initialStageId);
    if (!initialStage) {
      throw new Error(`Initial stage "${template.initialStageId}" not found in workflow "${workflowId}".`);
    }

    const now = new Date().toISOString();
    const updated = this.updateWorkflow(workflow, {
      status: WorkflowStatus.Active,
      currentStageId: initialStage.id,
      updatedAt: now,
    });

    // Activate the initial stage.
    const updatedStage = this.updateStage(initialStage, { status: StageStatus.Active, startedAt: now });
    await this.saveStageInList(workflowId, updatedStage, stages);
    await this.storage.saveWorkflow(updated);

    await this.emitEvent(workflowId, initialStage.id, null, null, 'stage_started', { stageName: initialStage.name });

    return updated;
  }

  // ─── Stage transitions ────────────────────────────────────────────────────────

  /**
   * Validate and execute a stage transition.
   * Throws with a human-readable message if the transition is not valid.
   */
  async advanceToStage(
    workflowId: string,
    targetStageId: string,
    template: WorkflowTemplate,
    triggeredByAgentId: string | null,
    triggeredByHuman = false
  ): Promise<ValidationResult> {
    const workflow = await this.requireWorkflow(workflowId);
    const stages = await this.storage.loadStages(workflowId);
    const artifacts = await this.artifactRegistry.getAll(workflowId);

    const currentStage = stages.find(s => s.id === workflow.currentStageId);
    const targetStage  = stages.find(s => s.id === targetStageId);

    if (!currentStage) {
      throw new Error(`Workflow "${workflowId}" has no active stage.`);
    }
    if (!targetStage) {
      throw new Error(`Target stage "${targetStageId}" not found in workflow "${workflowId}".`);
    }

    // Load all tasks for the current stage to check completion.
    const allTasksRaw = await this.storage.loadHandoffs(workflowId);
    const activeTasks = await this.loadCurrentStageTasks(workflowId, currentStage.id);
    const activeBlockers = await this.loadActiveBlockers(workflowId, currentStage.id);
    const grantedApprovals = Array.from(this.grantedApprovals.get(workflowId) ?? new Set<string>());

    const result = this.validator.validate({
      currentStage,
      targetStage,
      template,
      artifacts,
      activeBlockers,
      grantedApprovalCheckpointIds: grantedApprovals,
      activeTasks,
    });

    if (!result.isValid) {
      return result;
    }

    const now = new Date().toISOString();

    // Mark current stage complete.
    const completedCurrent = this.updateStage(currentStage, { status: StageStatus.Completed, completedAt: now });
    // Mark target stage active.
    const activatedTarget  = this.updateStage(targetStage, { status: StageStatus.Active, startedAt: now });

    const updatedStages = stages.map(s => {
      if (s.id === currentStage.id)  { return completedCurrent; }
      if (s.id === targetStageId)    { return activatedTarget; }
      return s;
    });

    const updatedWorkflow = this.updateWorkflow(workflow, {
      currentStageId: targetStageId,
      updatedAt: now,
    });

    await this.storage.saveStages(workflowId, updatedStages);
    await this.storage.saveWorkflow(updatedWorkflow);
    await this.emitEvent(workflowId, currentStage.id, null, triggeredByAgentId, 'stage_completed', { stageName: currentStage.name, isOverridden: false });
    await this.emitEvent(workflowId, targetStageId, null, triggeredByAgentId, 'stage_started', { stageName: targetStage.name, triggeredByHuman });

    return { isValid: true, errors: [] };
  }

  // ─── Task management ──────────────────────────────────────────────────────────

  /**
   * Create and activate a new task for the current stage.
   * Acquires the execution lock — throws if the workflow is already locked.
   */
  async createAndStartTask(params: {
    workflowId: string;
    stageId: string;
    title: string;
    objective: string;
    ownerAgentId: string;
    humanOwner: string;
    parentTaskId?: string;
    handoffRequestId?: string;
    sequence?: number;
  }): Promise<WorkflowTask> {
    const workflow = await this.requireWorkflow(params.workflowId);

    // Enforce single active agent.
    this.lock.acquire(params.workflowId, 'pending', params.ownerAgentId);

    const now = new Date().toISOString();
    const taskId = uuidv4();

    const task: WorkflowTask = {
      id: taskId,
      workflowId: params.workflowId,
      stageId: params.stageId,
      parentTaskId: params.parentTaskId ?? null,
      childTaskIds: [],
      title: params.title,
      objective: params.objective,
      ownerAgentId: params.ownerAgentId,
      humanOwner: params.humanOwner,
      status: TaskStatus.Active,
      handoffRequestId: params.handoffRequestId ?? null,
      reviewRequestId: null,
      sequence: params.sequence ?? 1,
      createdAt: now,
      startedAt: now,
      completedAt: null,
      failedAt: null,
      executionResult: null,
      notes: '',
    };

    // Re-acquire lock with the real task ID now that we have it.
    this.lock.release(params.workflowId);
    this.lock.acquire(params.workflowId, taskId, params.ownerAgentId);

    // Persist to mutable snapshot for stage-task queries (WF-103)
    const existingTasks = await this.storage.loadTasks(params.workflowId);
    existingTasks.push(task);
    await this.storage.saveTasks(params.workflowId, existingTasks);

    // If this is a child task, pause the parent and link it (WF-103)
    if (params.parentTaskId) {
      await this.pauseParentTask(params.workflowId, params.parentTaskId);
      await this.addChildToParentTask(params.workflowId, params.parentTaskId, taskId);
    }

    const updatedWorkflow = this.updateWorkflow(workflow, { activeTaskId: taskId, updatedAt: now });
    await this.storage.saveWorkflow(updatedWorkflow);
    await this.storage.appendTaskEntry(params.workflowId, task);
    await this.emitEvent(params.workflowId, params.stageId, taskId, params.ownerAgentId, 'task_created', { title: params.title });
    await this.emitEvent(params.workflowId, params.stageId, taskId, params.ownerAgentId, 'task_started', { title: params.title });

    return task;
  }

  /**
   * Process the structured result returned by an agent after task execution.
   * Releases the execution lock and updates task/workflow state.
   */
  async processExecutionResult(result: AgentExecutionResult): Promise<void> {
    const { taskId, workflowId, agentId, outcome } = result;
    const now = result.completedAt;

    this.lock.release(workflowId);

    await this.emitEvent(workflowId, null, taskId, agentId, 'execution_lock_released', { outcome });

    switch (outcome) {
      case ExecutionOutcome.Completed: {
        // Mark task as completed in snapshot
        const tasks = await this.storage.loadTasks(workflowId);
        const idx = tasks.findIndex(t => t.id === taskId);
        if (idx !== -1) {
          tasks[idx] = { ...tasks[idx], status: TaskStatus.Completed, completedAt: now };
          await this.storage.saveTasks(workflowId, tasks);
        }
        await this.emitEvent(workflowId, null, taskId, agentId, 'task_completed', { summary: result.summary });
        // Resume parent if this was a child task (WF-103)
        await this.resumeParentTask(workflowId, taskId);
        break;
      }

      case ExecutionOutcome.Delegated:
        if (result.handoffRequest) {
          await this.emitEvent(workflowId, null, taskId, agentId, 'handoff_created', {
            toAgent: result.handoffRequest.toAgentId,
            objective: result.handoffRequest.objective,
          });
        }
        break;

      case ExecutionOutcome.ReviewRequested:
        if (result.reviewRequest) {
          await this.emitEvent(workflowId, null, taskId, agentId, 'review_requested', {
            reviewerAgent: result.reviewRequest.reviewerAgentId,
            item: result.reviewRequest.itemUnderReview,
          });
        }
        break;

      case ExecutionOutcome.Blocked:
        if (result.blocker) {
          await this.emitEvent(workflowId, null, taskId, agentId, 'blocker_raised', {
            reason: result.blocker.reason,
            severity: result.blocker.severity,
          });
        }
        break;

      case ExecutionOutcome.Failed:
        await this.emitEvent(workflowId, null, taskId, agentId, 'task_failed', { summary: result.summary });
        break;
    }

    // Update workflow's active task pointer.
    const workflow = await this.requireWorkflow(workflowId);
    await this.storage.saveWorkflow(this.updateWorkflow(workflow, { activeTaskId: null, updatedAt: now }));
  }

  // ─── Cancellation ─────────────────────────────────────────────────────────────

  async cancelWorkflow(workflowId: string, reason: string, cancelledBy: string): Promise<void> {
    const workflow = await this.requireWorkflow(workflowId);
    const now = new Date().toISOString();

    this.lock.forceRelease(workflowId, `workflow cancelled by ${cancelledBy}: ${reason}`);

    const updated = this.updateWorkflow(workflow, {
      status: WorkflowStatus.Cancelled,
      cancelledAt: now,
      cancellationReason: reason,
      updatedAt: now,
    });
    await this.storage.saveWorkflow(updated);
    await this.emitEvent(workflowId, null, null, cancelledBy, 'workflow_cancelled', { reason });
  }

  // ─── Approval checkpoints ─────────────────────────────────────────────────────

  grantApproval(workflowId: string, checkpointId: string, grantedBy: string): void {
    if (!this.grantedApprovals.has(workflowId)) {
      this.grantedApprovals.set(workflowId, new Set());
    }
    this.grantedApprovals.get(workflowId)!.add(checkpointId);
    void this.emitEvent(workflowId, null, null, grantedBy, 'approval_checkpoint_granted', { checkpointId });
  }

  // ─── WF-401: Auto-resume after review ────────────────────────────────────────

  /**
   * Resume the task that requested a review after the review is completed.
   * The requesting task transitions from WaitingReview → Active.
   * Automatically called after ReviewManager.completeReview().
   */
  async resumeAfterReview(workflowId: string, reviewId: string): Promise<WorkflowTask | null> {
    const reviews = await this.storage.loadReviews(workflowId);
    const review = reviews.find(r => r.id === reviewId);
    if (!review) {
      return null;
    }

    const tasks = await this.storage.loadTasks(workflowId);
    const taskIndex = tasks.findIndex(t => t.reviewRequestId === reviewId);
    if (taskIndex === -1) {
      return null;
    }
    const task = tasks[taskIndex];
    if (task.status !== TaskStatus.WaitingReview) {
      return null;
    }

    tasks[taskIndex] = { ...task, status: TaskStatus.Active };
    await this.storage.saveTasks(workflowId, tasks);

    if (!this.lock.isLocked(workflowId)) {
      this.lock.acquire(workflowId, task.id, task.ownerAgentId);
    }

    await this.emitEvent(workflowId, task.stageId, task.id, task.ownerAgentId, 'task_resumed', {
      resumedAfterReviewId: reviewId,
      reviewOutcome: review.outcome,
      reviewComments: review.comments,
    });

    return tasks[taskIndex];
  }

  // ─── WF-403: Task and stage cancellation ─────────────────────────────────────

  /**
   * Cancel a specific task within a workflow.
   * Releases the execution lock if this task holds it.
   */
  async cancelTask(
    workflowId: string,
    taskId: string,
    reason: string,
    cancelledBy: string
  ): Promise<void> {
    const tasks = await this.storage.loadTasks(workflowId);
    const index = tasks.findIndex(t => t.id === taskId);
    if (index === -1) {
      throw new Error(`Task "${taskId}" not found in workflow "${workflowId}".`);
    }
    const task = tasks[index];
    const now = new Date().toISOString();

    tasks[index] = { ...task, status: TaskStatus.Cancelled, completedAt: now };
    await this.storage.saveTasks(workflowId, tasks);

    // Release lock if this task currently holds it
    const holder = this.lock.getLockHolder(workflowId);
    if (holder?.taskId === taskId) {
      this.lock.release(workflowId);
    }

    // Update workflow's active task pointer
    const workflow = await this.requireWorkflow(workflowId);
    if (workflow.activeTaskId === taskId) {
      await this.storage.saveWorkflow(this.updateWorkflow(workflow, { activeTaskId: null, updatedAt: now }));
    }

    await this.emitEvent(workflowId, task.stageId, taskId, cancelledBy, 'task_cancelled', { reason });
  }

  /**
   * Cancel all active and queued tasks within a stage.
   * Marks the stage as Completed (it is exiting, not succeeding).
   */
  async cancelStage(
    workflowId: string,
    stageId: string,
    reason: string,
    cancelledBy: string
  ): Promise<void> {
    const stages = await this.storage.loadStages(workflowId);
    const stageIndex = stages.findIndex(s => s.id === stageId);
    if (stageIndex === -1) {
      throw new Error(`Stage "${stageId}" not found in workflow "${workflowId}".`);
    }

    // Cancel all non-terminal tasks in this stage
    const tasks = await this.storage.loadTasks(workflowId);
    const now = new Date().toISOString();
    let lockReleased = false;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.stageId !== stageId) continue;
      if (['completed', 'cancelled', 'failed'].includes(t.status)) continue;

      tasks[i] = { ...t, status: TaskStatus.Cancelled, completedAt: now };

      const holder = this.lock.getLockHolder(workflowId);
      if (!lockReleased && holder?.taskId === t.id) {
        this.lock.release(workflowId);
        lockReleased = true;
      }
    }
    await this.storage.saveTasks(workflowId, tasks);

    // Mark stage as Completed
    stages[stageIndex] = this.updateStage(stages[stageIndex], { status: StageStatus.Completed, completedAt: now });
    await this.storage.saveStages(workflowId, stages);

    // Update workflow's current stage pointer
    const workflow = await this.requireWorkflow(workflowId);
    if (workflow.currentStageId === stageId) {
      await this.storage.saveWorkflow(this.updateWorkflow(workflow, { activeTaskId: null, updatedAt: now }));
    }

    await this.emitEvent(workflowId, stageId, null, cancelledBy, 'stage_completed', {
      cancelled: true,
      reason,
    });
  }

  // ─── WF-404: Workflow recovery on restart ────────────────────────────────────

  /**
   * Recover workflow state on VS Code restart.
   * - Restores lock state via ExecutionLock.recoverFromDisk() for stale-lock detection
   * - Identifies workflows in Active/Blocked state that need attention
   * - Returns a summary of recovery results
   */
  async recoverWorkflows(): Promise<{ recovered: string[]; requiresAttention: string[] }> {
    const workflowIds = await this.storage.listWorkflowIds();

    // Restore lock state (discards stale locks > 4h old)
    this.lock.recoverFromDisk(workflowIds);

    const recovered: string[] = [];
    const requiresAttention: string[] = [];

    for (const id of workflowIds) {
      const wf = await this.storage.loadWorkflow(id);
      if (!wf) continue;

      if (wf.status === WorkflowStatus.Active || wf.status === WorkflowStatus.Blocked) {
        const tasks = await this.storage.loadTasks(id);
        const activeTasks = tasks.filter(t => t.status === TaskStatus.Active);
        const lockIsHeld = this.lock.isLocked(id);

        if (activeTasks.length > 0 && !lockIsHeld) {
          // Active tasks exist but the lock was discarded (stale) — flag for human attention
          requiresAttention.push(id);
        } else {
          recovered.push(id);
        }
      }
    }

    return { recovered, requiresAttention };
  }

  // ─── WF-703: Workflow summary generation ─────────────────────────────────────

  /**
   * Generate a human-readable summary of the current workflow state.
   * Surfaces current stage, active task, pending reviews, blockers, and missing artifacts.
   * Designed for injection into agent prompts and for display in the workflow board.
   */
  async generateWorkflowSummary(workflowId: string): Promise<{
    workflowId: string;
    title: string;
    status: string;
    currentStageName: string | null;
    activeTaskTitle: string | null;
    completedStageCount: number;
    totalStageCount: number;
    activeBlockerCount: number;
    escalatedBlockerCount: number;
    pendingReviewCount: number;
    pendingHandoffCount: number;
    markdownSummary: string;
  }> {
    const workflow = await this.requireWorkflow(workflowId);
    const stages = await this.storage.loadStages(workflowId);
    const tasks = await this.storage.loadTasks(workflowId);
    const blockers = await this.storage.loadBlockers(workflowId);
    const reviews = await this.storage.loadReviews(workflowId);
    const handoffs = await this.storage.loadHandoffSnapshots(workflowId);

    const currentStage = stages.find(s => s.id === workflow.currentStageId) ?? null;
    const activeTask = tasks.find(t => t.id === workflow.activeTaskId) ?? null;
    const completedStages = stages.filter(s => s.status === StageStatus.Completed);
    const activeBlockers = blockers.filter(b => !b.isResolved);
    const escalatedBlockers = blockers.filter(b => b.isEscalated && !b.isResolved);
    const pendingReviews = reviews.filter(r => r.status === ReviewStatus.Pending);
    const pendingHandoffs = handoffs.filter(h => h.isApproved === null);

    const lines: string[] = [
      `## Workflow: ${workflow.title}`,
      `- **Status:** ${workflow.status}`,
      `- **Stages:** ${completedStages.length}/${stages.length} complete`,
      `- **Current Stage:** ${currentStage?.name ?? '—'}`,
      `- **Active Task:** ${activeTask?.title ?? '—'}`,
    ];

    if (activeBlockers.length > 0) {
      lines.push(`- **Active Blockers:** ${activeBlockers.length} (${escalatedBlockers.length} escalated)`);
      activeBlockers.slice(0, 3).forEach(b =>
        lines.push(`  - [${b.severity.toUpperCase()}] ${b.reason}`)
      );
    }
    if (pendingReviews.length > 0) {
      lines.push(`- **Pending Reviews:** ${pendingReviews.length}`);
    }
    if (pendingHandoffs.length > 0) {
      lines.push(`- **Pending Handoff Approvals:** ${pendingHandoffs.length}`);
    }

    return {
      workflowId,
      title: workflow.title,
      status: workflow.status,
      currentStageName: currentStage?.name ?? null,
      activeTaskTitle: activeTask?.title ?? null,
      completedStageCount: completedStages.length,
      totalStageCount: stages.length,
      activeBlockerCount: activeBlockers.length,
      escalatedBlockerCount: escalatedBlockers.length,
      pendingReviewCount: pendingReviews.length,
      pendingHandoffCount: pendingHandoffs.length,
      markdownSummary: lines.join('\n'),
    };
  }

  // ─── Query helpers ────────────────────────────────────────────────────────────

  async getWorkflow(workflowId: string): Promise<Workflow | null> {
    return this.storage.loadWorkflow(workflowId);
  }

  async getStages(workflowId: string): Promise<WorkflowStage[]> {
    return this.storage.loadStages(workflowId);
  }

  async listAllWorkflows(): Promise<Workflow[]> {
    return this.storage.loadAllWorkflows();
  }

  /** Get all tasks for a workflow from the mutable snapshot. */
  async getTasks(workflowId: string): Promise<WorkflowTask[]> {
    return this.storage.loadTasks(workflowId);
  }

  /** Get the active blockers for a workflow. */
  async getActiveBlockers(workflowId: string): Promise<Blocker[]> {
    return this.blockerTracker.getActive(workflowId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async requireWorkflow(workflowId: string): Promise<Workflow> {
    const wf = await this.storage.loadWorkflow(workflowId);
    if (!wf) {
      throw new Error(`Workflow "${workflowId}" not found. It may have been deleted or the workspace path has changed.`);
    }
    return wf;
  }

  private updateWorkflow(workflow: Workflow, patch: Partial<Workflow>): Workflow {
    return { ...workflow, ...patch };
  }

  private updateStage(stage: WorkflowStage, patch: Partial<WorkflowStage>): WorkflowStage {
    return { ...stage, ...patch };
  }

  private buildStage(workflowId: string, template: StageTemplate, now: string): WorkflowStage {
    return {
      id: uuidv4(),
      workflowId,
      templateStageId: template.id,
      name: template.name,
      description: template.description,
      ownerAgentId: template.ownerAgentId,
      humanOwner: '',
      status: StageStatus.Pending,
      sequence: template.sequence,
      requiredInputArtifactIds: [],
      requiredOutputArtifactIds: [],
      createdAt: now,
      startedAt: null,
      completedAt: null,
      isOverridden: false,
      overrideReason: null,
      overriddenBy: null,
    };
  }

  private async saveStageInList(workflowId: string, stage: WorkflowStage, allStages: WorkflowStage[]): Promise<void> {
    const updated = allStages.map(s => s.id === stage.id ? stage : s);
    await this.storage.saveStages(workflowId, updated);
  }

  private async addChildToParentTask(workflowId: string, parentTaskId: string, childTaskId: string): Promise<void> {
    // The task list is append-only in JSONL; we emit a task update event instead.
    await this.emitEvent(workflowId, null, parentTaskId, null, 'task_created', {
      parentTaskId,
      childTaskId,
      note: 'Child task linked to parent.',
    });
  }

  // ─── WF-103: Parent-child task orchestration ─────────────────────────────────

  /**
   * Pause a parent task while a child task executes.
   * Transitions parent status from Active → WaitingChild and updates workflow state.
   * Called automatically by createAndStartTask() when parentTaskId is supplied.
   */
  async pauseParentTask(workflowId: string, parentTaskId: string): Promise<void> {
    const tasks = await this.storage.loadTasks(workflowId);
    const index = tasks.findIndex(t => t.id === parentTaskId);
    if (index === -1) {
      return; // Parent not found — non-fatal; child proceeds independently
    }
    const parent = tasks[index];
    if (parent.status !== TaskStatus.Active) {
      return; // Already paused or completed — no action needed
    }

    tasks[index] = { ...parent, status: TaskStatus.WaitingChild };
    await this.storage.saveTasks(workflowId, tasks);
    await this.emitEvent(workflowId, parent.stageId, parentTaskId, null, 'task_started', {
      note: 'Parent task paused — waiting for child task to complete.',
      childTriggered: true,
    });
  }

  /**
   * Resume a parent task after its child completes.
   * Transitions the parent from WaitingChild → Active.
   * Called automatically by processExecutionResult() when a child task finishes.
   */
  async resumeParentTask(workflowId: string, completedChildTaskId: string): Promise<WorkflowTask | null> {
    const tasks = await this.storage.loadTasks(workflowId);
    const child = tasks.find(t => t.id === completedChildTaskId);
    if (!child?.parentTaskId) {
      return null; // No parent to resume
    }

    const parentIndex = tasks.findIndex(t => t.id === child.parentTaskId);
    if (parentIndex === -1) {
      return null;
    }
    const parent = tasks[parentIndex];
    if (parent.status !== TaskStatus.WaitingChild) {
      return null; // Parent not in expected state
    }

    tasks[parentIndex] = { ...parent, status: TaskStatus.Active };
    await this.storage.saveTasks(workflowId, tasks);

    // Re-acquire the execution lock for the resumed parent
    if (!this.lock.isLocked(workflowId)) {
      this.lock.acquire(workflowId, parent.id, parent.ownerAgentId);
    }

    await this.emitEvent(workflowId, parent.stageId, parent.id, parent.ownerAgentId, 'task_resumed', {
      resumedAfterChildId: completedChildTaskId,
    });

    return tasks[parentIndex];
  }

  // ─── WF-105: Blocker handling ─────────────────────────────────────────────────

  /**
   * Raise a new blocker for the given workflow, stage, and task.
   * Transitions the task and (optionally) the workflow to Blocked status.
   */
  async raiseBlocker(params: {
    workflowId: string;
    stageId: string;
    taskId: string;
    raisedByAgentId: string;
    reason: string;
    severity: BlockerSeverity;
    suggestedRoute: string;
    pauseWorkflow?: boolean;
  }): Promise<Blocker> {
    const { workflowId, pauseWorkflow = false } = params;

    const blocker = await this.blockerTracker.raise(workflowId, {
      stageId: params.stageId,
      taskId: params.taskId,
      raisedByAgentId: params.raisedByAgentId,
      reason: params.reason,
      severity: params.severity,
      suggestedRoute: params.suggestedRoute,
    });

    // Transition task to Blocked status
    const tasks = await this.storage.loadTasks(workflowId);
    const taskIndex = tasks.findIndex(t => t.id === params.taskId);
    if (taskIndex !== -1 && tasks[taskIndex].status === TaskStatus.Active) {
      tasks[taskIndex] = { ...tasks[taskIndex], status: TaskStatus.Blocked };
      await this.storage.saveTasks(workflowId, tasks);
    }

    // Optionally transition workflow to Blocked
    if (pauseWorkflow) {
      const workflow = await this.requireWorkflow(workflowId);
      if (workflow.status === WorkflowStatus.Active) {
        const updated = this.updateWorkflow(workflow, {
          status: WorkflowStatus.Blocked,
          updatedAt: new Date().toISOString(),
        });
        await this.storage.saveWorkflow(updated);
      }
    }

    await this.emitEvent(workflowId, params.stageId, params.taskId, params.raisedByAgentId,
      'blocker_raised', {
        blockerId: blocker.id,
        reason: blocker.reason,
        severity: blocker.severity,
      });

    return blocker;
  }

  /**
   * Resolve a blocker and, if the task was blocked, resume it.
   */
  async resolveBlocker(
    workflowId: string,
    blockerId: string,
    resolutionNotes: string,
    resolvedBy: string
  ): Promise<void> {
    const blocker = await this.blockerTracker.getById(workflowId, blockerId);
    if (!blocker) {
      throw new Error(`Blocker "${blockerId}" not found in workflow "${workflowId}".`);
    }

    await this.blockerTracker.resolve(workflowId, blockerId, resolutionNotes, resolvedBy);

    // Resume the blocked task if it has no other active blockers
    const remainingBlockers = await this.blockerTracker.getActiveByStage(workflowId, blocker.stageId);
    const taskStillBlocked = remainingBlockers.some(b => b.taskId === blocker.taskId && b.id !== blockerId);

    if (!taskStillBlocked) {
      const tasks = await this.storage.loadTasks(workflowId);
      const taskIndex = tasks.findIndex(t => t.id === blocker.taskId);
      if (taskIndex !== -1 && tasks[taskIndex].status === TaskStatus.Blocked) {
        tasks[taskIndex] = { ...tasks[taskIndex], status: TaskStatus.Active };
        await this.storage.saveTasks(workflowId, tasks);
      }
    }

    // Check if we can un-block the workflow
    const activeBlockers = await this.blockerTracker.getActive(workflowId);
    if (activeBlockers.length === 0) {
      const workflow = await this.requireWorkflow(workflowId);
      if (workflow.status === WorkflowStatus.Blocked) {
        const updated = this.updateWorkflow(workflow, {
          status: WorkflowStatus.Active,
          updatedAt: new Date().toISOString(),
        });
        await this.storage.saveWorkflow(updated);
      }
    }

    await this.emitEvent(workflowId, blocker.stageId, blocker.taskId, resolvedBy,
      'blocker_resolved', { blockerId, resolutionNotes });
  }

  /**
   * Escalate a blocker to the human owner for decision.
   */
  async escalateBlocker(
    workflowId: string,
    blockerId: string,
    escalatedBy: string
  ): Promise<void> {
    const blocker = await this.blockerTracker.getById(workflowId, blockerId);
    if (!blocker) {
      throw new Error(`Blocker "${blockerId}" not found in workflow "${workflowId}".`);
    }

    await this.blockerTracker.escalate(workflowId, blockerId, escalatedBy);
    await this.emitEvent(workflowId, blocker.stageId, blocker.taskId, escalatedBy,
      'blocker_escalated', { blockerId, reason: blocker.reason });
  }

  // ─── WF-106: Return-for-revision ─────────────────────────────────────────────

  /**
   * Downstream agent returns work to an upstream task owner for revision.
   * The original task is re-opened with Active status and an annotation describing
   * what needs to change. A full audit trail records the return chain.
   *
   * Examples:
   *   - QA returns failed test evidence to the Advanced Coder
   *   - Advanced Coder raises a design concern back to the Solution Architect
   */
  async requestRevision(params: {
    workflowId: string;
    fromAgentId: string;
    fromTaskId: string;
    toTaskId: string;
    reason: string;
    requiredChanges: string[];
  }): Promise<void> {
    const { workflowId } = params;
    const tasks = await this.storage.loadTasks(workflowId);

    const targetIndex = tasks.findIndex(t => t.id === params.toTaskId);
    if (targetIndex === -1) {
      throw new Error(
        `Target task "${params.toTaskId}" not found in workflow "${workflowId}". ` +
        `Cannot request revision from a task that does not exist.`
      );
    }

    const target = tasks[targetIndex];
    const now = new Date().toISOString();

    // Re-open the target task — append revision notes
    const revisionNote = [
      `[REVISION REQUEST @ ${now}]`,
      `From: ${params.fromAgentId} (task: ${params.fromTaskId})`,
      `Reason: ${params.reason}`,
      `Required changes:`,
      ...params.requiredChanges.map(c => `  - ${c}`),
    ].join('\n');

    tasks[targetIndex] = {
      ...target,
      status: TaskStatus.Active,
      completedAt: null,
      notes: target.notes ? `${target.notes}\n\n${revisionNote}` : revisionNote,
    };

    await this.storage.saveTasks(workflowId, tasks);

    await this.emitEvent(workflowId, target.stageId, params.toTaskId, params.fromAgentId,
      'task_resumed', {
        revisionRequested: true,
        fromTaskId: params.fromTaskId,
        reason: params.reason,
        requiredChanges: params.requiredChanges,
      });
  }

  // ─── Task loading (replaces Phase-1 stubs) ────────────────────────────────────

  /** Load tasks for a given stage from the mutable snapshot. */
  private async loadCurrentStageTasks(workflowId: string, stageId: string): Promise<WorkflowTask[]> {
    const tasks = await this.storage.loadTasks(workflowId);
    return tasks.filter(t => t.stageId === stageId);
  }

  /** Load all unresolved blockers from the mutable snapshot. */
  private async loadActiveBlockers(workflowId: string, stageId: string): Promise<Blocker[]> {
    return this.blockerTracker.getActiveByStage(workflowId, stageId);
  }

  private async emitEvent(
    workflowId: string,
    stageId: string | null,
    taskId: string | null,
    agentId: string | null,
    eventType: WorkflowEvent['eventType'],
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: WorkflowEvent = {
      id: uuidv4(),
      workflowId,
      stageId,
      taskId,
      agentId,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    };
    await this.storage.appendEvent(workflowId, event);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────────

/** Convenience factory: creates a ready-to-use WorkflowEngine with default collaborators. */
export function createWorkflowEngine(workspaceRoot: string): WorkflowEngine {
  const storage       = new WorkflowStorage(workspaceRoot);
  const lock          = new ExecutionLock(workspaceRoot);
  const registry      = new ArtifactRegistry(storage);
  const validator     = new TransitionValidator();
  const blockerTracker = new BlockerTracker(storage);

  return new WorkflowEngine({ workspaceRoot, storage, lock, artifactRegistry: registry, validator, blockerTracker });
}
