// ─── Workflow domain entity types ──────────────────────────────────────────────
//
// WF-001: All entities include stable IDs, ISO-8601 timestamps, status enums,
// agent/human ownership, and parent-child relationships where applicable.
//
// These types are intentionally separate from src/types.ts (agent/chat types)
// to keep the workflow module self-contained and independently testable.

import type {
  WorkflowStatus,
  TaskStatus,
  StageStatus,
  ReviewStatus,
  BlockerSeverity,
  ExecutionOutcome,
  ArtifactApprovalStatus,
  QuestionStatus,
} from './enums';

// ─── Core workflow entities ─────────────────────────────────────────────────────

export interface Workflow {
  id: string;
  title: string;
  templateId: string;
  status: WorkflowStatus;
  humanOwner: string;
  currentStageId: string | null;
  activeTaskId: string | null;
  workspaceRoot: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  linkedIssueId: string | null;
  metadata: Record<string, unknown>;
}

export interface WorkflowStage {
  id: string;
  workflowId: string;
  templateStageId: string;
  name: string;
  description: string;
  ownerAgentId: string;
  humanOwner: string;
  status: StageStatus;
  sequence: number;         // execution order within workflow
  requiredInputArtifactIds: string[];
  requiredOutputArtifactIds: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  isOverridden: boolean;
  overrideReason: string | null;
  overriddenBy: string | null;
}

export interface WorkflowTask {
  id: string;
  workflowId: string;
  stageId: string;
  parentTaskId: string | null;
  childTaskIds: string[];
  title: string;
  objective: string;
  ownerAgentId: string;
  humanOwner: string;
  status: TaskStatus;
  handoffRequestId: string | null;
  reviewRequestId: string | null;
  sequence: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  executionResult: ExecutionOutcome | null;
  notes: string;
}

// ─── Handoff and review entities ───────────────────────────────────────────────

export interface HandoffRequest {
  id: string;
  workflowId: string;
  taskId: string;
  parentTaskId: string | null;
  stageId: string;
  fromAgentId: string;
  toAgentId: string;
  returnToAgentId: string | null;  // agent to resume after child completes
  objective: string;
  reasonForHandoff: string;
  inputArtifactIds: string[];
  relevantDecisionIds: string[];
  constraints: string[];
  expectedOutputs: string[];
  doneCriteria: string[];
  isBlocking: boolean;
  isApproved: boolean | null;      // null = pending human review
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  humanNote: string | null;
  createdAt: string;
}

export interface ReviewRequest {
  id: string;
  workflowId: string;
  taskId: string;
  requestingAgentId: string;
  reviewerAgentId: string;
  itemUnderReview: string;   // description of what is being reviewed
  reviewScope: string;
  reviewCriteria: string[];
  isBlocking: boolean;
  status: ReviewStatus;
  outcome: 'approved' | 'approved_with_comments' | 'rejected' | null;
  comments: string | null;
  rejectionReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ─── Blocker and question entities ─────────────────────────────────────────────

export interface Blocker {
  id: string;
  workflowId: string;
  stageId: string;
  taskId: string;
  raisedByAgentId: string;
  reason: string;
  severity: BlockerSeverity;
  suggestedRoute: string;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  isResolved: boolean;
  isEscalated: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface OpenQuestion {
  id: string;
  workflowId: string;
  taskId: string;
  raisedByAgentId: string;
  questionText: string;
  context: string;
  optionsConsidered: string[];
  isBlocking: boolean;
  status: QuestionStatus;
  assumption: string | null;   // what the agent assumes if non-blocking
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
}

// ─── Artifact entity ────────────────────────────────────────────────────────────

export interface Artifact {
  id: string;
  workflowId: string;
  stageId: string;
  taskId: string;
  producingAgentId: string;
  name: string;
  description: string;
  type: string;           // e.g. 'requirements', 'architecture', 'code', 'test-report'
  path: string;           // workspace-relative path
  version: number;        // starts at 1, incremented on supersede
  approvalStatus: ArtifactApprovalStatus;
  supersededById: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Decision log entity ────────────────────────────────────────────────────────

export interface DecisionLogEntry {
  id: string;
  workflowId: string;
  stageId: string;
  taskId: string;
  ownerAgentId: string;
  title: string;
  rationale: string;
  alternativesConsidered: string[];
  impact: string;
  linkedArtifactIds: string[];
  linkedTaskIds: string[];
  createdAt: string;
}

// ─── Stage transition entity ────────────────────────────────────────────────────

export interface StageTransition {
  id: string;
  workflowId: string;
  fromStageId: string | null;   // null for initial transition
  toStageId: string;
  triggeredByAgentId: string;
  triggeredByHuman: boolean;
  isOverridden: boolean;
  overrideReason: string | null;
  validationErrors: string[];
  createdAt: string;
}

// ─── Agent execution result ─────────────────────────────────────────────────────

export interface AgentExecutionResult {
  taskId: string;
  workflowId: string;
  agentId: string;
  outcome: ExecutionOutcome;
  summary: string;
  producedArtifactIds: string[];
  delegateTo: string | null;          // agentId if outcome === 'delegated'
  handoffRequest: Omit<HandoffRequest, 'id' | 'createdAt' | 'isApproved' | 'approvedBy' | 'approvedAt' | 'rejectionReason' | 'humanNote'> | null;
  reviewRequest: Omit<ReviewRequest, 'id' | 'createdAt' | 'completedAt' | 'status' | 'outcome' | 'comments' | 'rejectionReason'> | null;
  blocker: Omit<Blocker, 'id' | 'createdAt' | 'resolvedAt' | 'isResolved' | 'isEscalated' | 'resolutionNotes' | 'resolvedBy'> | null;
  completedAt: string;
}

// ─── Workflow event (append-only audit entry for workflow events) ───────────────

export interface WorkflowEvent {
  id: string;
  workflowId: string;
  taskId: string | null;
  stageId: string | null;
  agentId: string | null;
  eventType: WorkflowEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type WorkflowEventType =
  | 'workflow_created'
  | 'workflow_completed'
  | 'workflow_cancelled'
  | 'stage_started'
  | 'stage_completed'
  | 'stage_overridden'
  | 'task_created'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled'
  | 'task_resumed'
  | 'handoff_created'
  | 'handoff_approved'
  | 'handoff_rejected'
  | 'review_requested'
  | 'review_completed'
  | 'blocker_raised'
  | 'blocker_resolved'
  | 'blocker_escalated'
  | 'artifact_registered'
  | 'artifact_approved'
  | 'artifact_rejected'
  | 'artifact_superseded'
  | 'decision_recorded'
  | 'question_raised'
  | 'question_answered'
  | 'execution_lock_acquired'
  | 'execution_lock_released'
  | 'approval_checkpoint_reached'
  | 'approval_checkpoint_granted'
  | 'override_applied';

// ─── Validation result (used by TransitionValidator) ───────────────────────────

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  code: string;
  message: string;
  field?: string;
  expectedValue?: unknown;
  actualValue?: unknown;
}
