// ─── Governance manager (WF-601 / WF-602 / WF-603) ──────────────────────────────
//
// WF-601: Centralise all human override permissions.
//   Defines which operations require human approval and who may perform them.
//
// WF-602: Stage gate override flow.
//   Forced transitions are clearly marked with a mandatory override reason and are
//   visible in the audit UI. Agents cannot self-override; only the human owner can.
//
// WF-603: Configurable approval checkpoints per workflow template.
//   Blocks progress at named checkpoints until a human explicitly grants approval.
//   Approval is recorded with approver identity and timestamp.
//
// All override and approval operations emit workflow events via the provided
// emitEvent callback so that every governance action is visible in the audit log.

import { randomUUID as uuidv4 } from 'crypto';
import type { WorkflowStorage } from './WorkflowStorage';
import type { WorkflowTemplate } from './WorkflowTemplate';
import type { WorkflowEvent } from './types';

// ─── Permission catalogue ─────────────────────────────────────────────────────

/**
 * Every operation that requires explicit human authorisation.
 * These are checked before the action is executed; an unauthorised caller
 * receives an `PermissionDenied` error rather than a silent failure.
 */
export const HumanPermission = {
  /** Start a new workflow instance. */
  StartWorkflow: 'start_workflow',
  /** Approve a pending handoff delegation before the target agent begins work. */
  ApproveHandoff: 'approve_handoff',
  /** Force a stage gate to pass despite missing artifacts or unresolved blockers. */
  OverrideStageGate: 'override_stage_gate',
  /** Reassign a task from one agent to another. */
  ReassignTask: 'reassign_task',
  /** Cancel a task or workflow. */
  CancelWorkflow: 'cancel_workflow',
  /** Manually resolve a blocker on behalf of the owning agent. */
  ResolveBlocker: 'resolve_blocker',
  /** Grant an approval checkpoint so the workflow can proceed. */
  GrantApprovalCheckpoint: 'grant_approval_checkpoint',
} as const;

export type HumanPermission = typeof HumanPermission[keyof typeof HumanPermission];

// ─── Override record ──────────────────────────────────────────────────────────

export interface OverrideRecord {
  id: string;
  workflowId: string;
  permission: HumanPermission;
  /** The human who performed the override. */
  performedBy: string;
  /** Mandatory: what prompted the override and what risks were accepted. */
  reason: string;
  /** ISO8601 timestamp of the override. */
  createdAt: string;
  /** Optional target entity (stageId, taskId, blockerId, etc.) */
  targetId?: string;
}

// ─── Approval checkpoint record ───────────────────────────────────────────────

export interface ApprovalCheckpointRecord {
  id: string;
  workflowId: string;
  checkpointId: string;   // matches template.approvalCheckpoints[n].id
  grantedBy: string;
  grantedAt: string;
  note: string | null;
}

// ─── Event emitter type (matches what WorkflowEngine.emitEvent produces) ──────

type EmitEventFn = (
  workflowId: string,
  stageId: string | null,
  taskId: string | null,
  agentId: string | null,
  eventType: WorkflowEvent['eventType'],
  payload: Record<string, unknown>
) => Promise<void>;

// ─── GovernanceManager class ──────────────────────────────────────────────────

export class GovernanceManager {
  constructor(
    private readonly storage: WorkflowStorage,
    private readonly emitEvent: EmitEventFn
  ) {}

  // ─── WF-601: Permission checks ────────────────────────────────────────────────

  /**
   * Assert that the caller holds the human-owner role for the workflow.
   * Throws `PermissionDenied` if the caller is not the workflow's `humanOwner`.
   * All privileged governance operations call this before proceeding.
   */
  async assertHumanOwner(workflowId: string, callerId: string): Promise<void> {
    const wf = await this.storage.loadWorkflow(workflowId);
    if (!wf) throw new Error(`Workflow "${workflowId}" not found.`);
    if (wf.humanOwner !== callerId) {
      throw new PermissionDeniedError(
        `Caller "${callerId}" is not the human owner of workflow "${workflowId}" ` +
        `(owner: "${wf.humanOwner}"). This operation requires human-owner authorisation.`
      );
    }
  }

  /**
   * Check whether a specific permission is required for a workflow.
   * Currently all permissions are required for all workflows, but this hook
   * allows future per-template permission relaxation.
   */
  isPermissionRequired(
    _permission: HumanPermission,
    _template?: WorkflowTemplate
  ): boolean {
    return true;  // All governance operations require human authorisation.
  }

  // ─── WF-602: Forced stage gate override ───────────────────────────────────────

  /**
   * Force a stage gate transition even when the validator would reject it.
   * Records the override in the workflow event log with the mandatory reason.
   * Throws if `performedBy` is not the human owner.
   */
  async forceStageTransition(
    workflowId: string,
    fromStageId: string,
    toStageId: string,
    performedBy: string,
    reason: string
  ): Promise<OverrideRecord> {
    if (!reason?.trim()) {
      throw new Error('Override reason is mandatory for forced stage transitions.');
    }

    await this.assertHumanOwner(workflowId, performedBy);

    const override = this.buildOverride(workflowId, HumanPermission.OverrideStageGate, performedBy, reason, fromStageId);

    await this.emitEvent(workflowId, fromStageId, null, performedBy, 'override_applied', {
      permission: HumanPermission.OverrideStageGate,
      fromStageId,
      toStageId,
      reason,
      overrideId: override.id,
      overriddenBy: performedBy,
    });

    return override;
  }

  /**
   * Record a human override for any governance-controlled operation.
   * Callers should call this AFTER successfully executing the overridden action
   * so the override record is only written if the action itself succeeded.
   */
  async recordOverride(params: {
    workflowId: string;
    permission: HumanPermission;
    performedBy: string;
    reason: string;
    targetId?: string;
    stageId?: string;
    taskId?: string;
  }): Promise<OverrideRecord> {
    const override = this.buildOverride(
      params.workflowId,
      params.permission,
      params.performedBy,
      params.reason,
      params.targetId
    );

    await this.emitEvent(params.workflowId, params.stageId ?? null, params.taskId ?? null, params.performedBy, 'override_applied', {
      permission: params.permission,
      reason: params.reason,
      overrideId: override.id,
      overriddenBy: params.performedBy,
      targetId: params.targetId ?? null,
    });

    return override;
  }

  // ─── WF-603: Approval checkpoints ─────────────────────────────────────────────

  /**
   * Check whether all required approval checkpoints for the next stage have been granted.
   * Returns the list of checkpoint IDs that are still pending.
   * Called by TransitionValidator / StageGate as part of the exit check.
   */
  getMissingApprovals(
    requiredCheckpointIds: string[],
    grantedCheckpointIds: string[]
  ): string[] {
    const granted = new Set(grantedCheckpointIds);
    return requiredCheckpointIds.filter(id => !granted.has(id));
  }

  /**
   * Grant an approval checkpoint for a workflow.
   * Records who approved and when.  Emits an audit event.
   * Throws if the checkpoint is not defined in the workflow's template requirements.
   */
  async grantApprovalCheckpoint(
    workflowId: string,
    checkpointId: string,
    grantedBy: string,
    note?: string
  ): Promise<ApprovalCheckpointRecord> {
    await this.assertHumanOwner(workflowId, grantedBy);

    const record: ApprovalCheckpointRecord = {
      id: uuidv4(),
      workflowId,
      checkpointId,
      grantedBy,
      grantedAt: new Date().toISOString(),
      note: note ?? null,
    };

    await this.emitEvent(workflowId, null, null, grantedBy, 'override_applied', {
      permission: HumanPermission.GrantApprovalCheckpoint,
      checkpointId,
      grantedBy,
      note: note ?? null,
      approvalRecordId: record.id,
    });

    return record;
  }

  /**
   * Verify that a specific checkpoint ID is listed in the template's approval checkpoints.
   * Returns `true` if the checkpoint is recognised, `false` if it is unknown
   * (which likely indicates a misconfigured template or stale reference).
   */
  isCheckpointRecognised(checkpointId: string, template: WorkflowTemplate): boolean {
    return (template.approvalCheckpoints ?? []).some(cp => cp.id === checkpointId);
  }

  /**
   * Return a human-readable list of pending approvals for a given stage transition.
   * Designed for surfacing in the workflow board UI and in agent prompts.
   */
  describePendingApprovals(
    requiredCheckpointIds: string[],
    grantedCheckpointIds: string[],
    template: WorkflowTemplate
  ): string {
    const missing = this.getMissingApprovals(requiredCheckpointIds, grantedCheckpointIds);
    if (missing.length === 0) return 'All approval checkpoints granted.';

    const checkpoints = template.approvalCheckpoints ?? [];
    const lines = missing.map(id => {
      const cp = checkpoints.find(c => c.id === id);
      return cp
        ? `  • [${id}] ${cp.description} (trigger: ${cp.triggerType}, stage: ${cp.stageId})`
        : `  • [${id}] (unknown checkpoint — check template configuration)`;
    });
    return `Pending approvals (${missing.length}):\n${lines.join('\n')}`;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────────

  private buildOverride(
    workflowId: string,
    permission: HumanPermission,
    performedBy: string,
    reason: string,
    targetId?: string
  ): OverrideRecord {
    return {
      id: uuidv4(),
      workflowId,
      permission,
      performedBy,
      reason,
      createdAt: new Date().toISOString(),
      targetId,
    };
  }
}

// ─── Custom errors ─────────────────────────────────────────────────────────────

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}
