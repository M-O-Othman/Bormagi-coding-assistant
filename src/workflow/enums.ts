// ─── Workflow domain enums (WF-002) ────────────────────────────────────────────
//
// All status values are defined here. No string literals for workflow status
// may appear outside this file. Import from here wherever status checks are needed.

// ─── Workflow lifecycle ─────────────────────────────────────────────────────────

export const WorkflowStatus = {
  Draft:      'draft',
  Active:     'active',
  Blocked:    'blocked',
  Completed:  'completed',
  Cancelled:  'cancelled',
} as const;
export type WorkflowStatus = typeof WorkflowStatus[keyof typeof WorkflowStatus];

// ─── Stage lifecycle ────────────────────────────────────────────────────────────

export const StageStatus = {
  Pending:    'pending',
  Active:     'active',
  Blocked:    'blocked',
  Completed:  'completed',
  Skipped:    'skipped',
} as const;
export type StageStatus = typeof StageStatus[keyof typeof StageStatus];

// ─── Task lifecycle ─────────────────────────────────────────────────────────────

export const TaskStatus = {
  Queued:         'queued',
  Active:         'active',
  WaitingReview:  'waiting_review',
  WaitingChild:   'waiting_child',
  Blocked:        'blocked',
  Completed:      'completed',
  Failed:         'failed',
  Cancelled:      'cancelled',
} as const;
export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];

// ─── Review lifecycle ───────────────────────────────────────────────────────────

export const ReviewStatus = {
  Pending:   'pending',
  Completed: 'completed',
  Cancelled: 'cancelled',
} as const;
export type ReviewStatus = typeof ReviewStatus[keyof typeof ReviewStatus];

// ─── Blocker severity ───────────────────────────────────────────────────────────

export const BlockerSeverity = {
  Low:      'low',
  Medium:   'medium',
  High:     'high',
  Critical: 'critical',
} as const;
export type BlockerSeverity = typeof BlockerSeverity[keyof typeof BlockerSeverity];

// ─── Agent execution outcome ────────────────────────────────────────────────────

export const ExecutionOutcome = {
  Completed:       'completed',
  Delegated:       'delegated',
  ReviewRequested: 'review_requested',
  Blocked:         'blocked',
  Failed:          'failed',
} as const;
export type ExecutionOutcome = typeof ExecutionOutcome[keyof typeof ExecutionOutcome];

// ─── Artifact approval lifecycle ───────────────────────────────────────────────

export const ArtifactApprovalStatus = {
  Draft:      'draft',
  Submitted:  'submitted',
  Approved:   'approved',
  Rejected:   'rejected',
  Superseded: 'superseded',
} as const;
export type ArtifactApprovalStatus = typeof ArtifactApprovalStatus[keyof typeof ArtifactApprovalStatus];

// ─── Open question states ───────────────────────────────────────────────────────

export const QuestionStatus = {
  Open:      'open',
  Answered:  'answered',
  Deferred:  'deferred',
  Blocked:   'blocked',
} as const;
export type QuestionStatus = typeof QuestionStatus[keyof typeof QuestionStatus];

// ─── Valid transition tables ────────────────────────────────────────────────────
//
// Defines which status values a workflow, stage, or task may move to from each
// current status. Used by the state machine and TransitionValidator.

export const WORKFLOW_VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  [WorkflowStatus.Draft]:     [WorkflowStatus.Active, WorkflowStatus.Cancelled],
  [WorkflowStatus.Active]:    [WorkflowStatus.Blocked, WorkflowStatus.Completed, WorkflowStatus.Cancelled],
  [WorkflowStatus.Blocked]:   [WorkflowStatus.Active, WorkflowStatus.Cancelled],
  [WorkflowStatus.Completed]: [],
  [WorkflowStatus.Cancelled]: [],
};

export const STAGE_VALID_TRANSITIONS: Record<StageStatus, StageStatus[]> = {
  [StageStatus.Pending]:   [StageStatus.Active, StageStatus.Skipped],
  [StageStatus.Active]:    [StageStatus.Blocked, StageStatus.Completed],
  [StageStatus.Blocked]:   [StageStatus.Active],
  [StageStatus.Completed]: [],
  [StageStatus.Skipped]:   [],
};

export const TASK_VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.Queued]:        [TaskStatus.Active, TaskStatus.Cancelled],
  [TaskStatus.Active]:        [TaskStatus.WaitingReview, TaskStatus.WaitingChild, TaskStatus.Blocked, TaskStatus.Completed, TaskStatus.Failed, TaskStatus.Cancelled],
  [TaskStatus.WaitingReview]: [TaskStatus.Active, TaskStatus.Completed, TaskStatus.Cancelled],
  [TaskStatus.WaitingChild]:  [TaskStatus.Active, TaskStatus.Cancelled],
  [TaskStatus.Blocked]:       [TaskStatus.Active, TaskStatus.Cancelled],
  [TaskStatus.Completed]:     [],
  [TaskStatus.Failed]:        [TaskStatus.Active],  // allow retry
  [TaskStatus.Cancelled]:     [],
};
