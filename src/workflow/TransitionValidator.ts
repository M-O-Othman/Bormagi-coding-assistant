// ─── Stage transition validator (WF-104) ───────────────────────────────────────
//
// Validates that a workflow may legally move from one stage to another.
// Checks:
//   1. Required input artifacts exist and are approved.
//   2. Required approvals (human checkpoints) have been granted.
//   3. No unresolved blocking blockers prevent the transition.
//   4. The target stage is listed in the current stage's allowedNextStageIds.
//
// Reusable from both the UI (to show what is missing) and the WorkflowEngine
// (to enforce transitions).

import { ArtifactApprovalStatus } from './enums';
import type { Artifact, Blocker, ValidationResult, ValidationError, WorkflowStage, WorkflowTask } from './types';
import type { StageTemplate, WorkflowTemplate } from './WorkflowTemplate';

export interface TransitionContext {
  /** The stage being left. */
  currentStage: WorkflowStage;
  /** The stage being entered. */
  targetStage: WorkflowStage;
  /** The template for the whole workflow (used to look up allowed transitions). */
  template: WorkflowTemplate;
  /** All artifacts registered for the workflow so far. */
  artifacts: Artifact[];
  /** All unresolved blockers for the workflow so far. */
  activeBlockers: Blocker[];
  /** IDs of approval checkpoints that have already been granted. */
  grantedApprovalCheckpointIds: string[];
  /** Active tasks in the current stage (used to check completion). */
  activeTasks: WorkflowTask[];
}

export class TransitionValidator {

  /**
   * Validate a stage-to-stage transition.
   * Returns a `ValidationResult` describing all missing prerequisites.
   * The result is safe to present directly to the user.
   */
  validate(context: TransitionContext): ValidationResult {
    const errors: ValidationError[] = [];

    errors.push(...this.checkAllowedTransition(context));
    errors.push(...this.checkNoActiveTasks(context));
    errors.push(...this.checkRequiredInputArtifacts(context));
    errors.push(...this.checkRequiredOutputArtifacts(context));
    errors.push(...this.checkNoBlockingBlockers(context));
    errors.push(...this.checkApprovalCheckpoints(context));

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Validate that the workflow may *enter* a given stage (start checks only).
   * Used before a new stage begins executing.
   */
  validateEntry(context: Omit<TransitionContext, 'activeTasks'>): ValidationResult {
    const errors: ValidationError[] = [];

    errors.push(...this.checkAllowedTransition(context as TransitionContext));
    errors.push(...this.checkRequiredInputArtifacts(context as TransitionContext));
    errors.push(...this.checkNoBlockingBlockers(context as TransitionContext));
    errors.push(...this.checkApprovalCheckpoints(context as TransitionContext));

    return { isValid: errors.length === 0, errors };
  }

  // ─── Individual checks ────────────────────────────────────────────────────────

  private checkAllowedTransition(context: TransitionContext): ValidationError[] {
    const currentTemplate = this.findStageTemplate(context.template, context.currentStage.templateStageId);
    if (!currentTemplate) {
      return [{
        code: 'STAGE_TEMPLATE_NOT_FOUND',
        message: `No template found for current stage "${context.currentStage.templateStageId}".`,
      }];
    }

    if (!currentTemplate.allowedNextStageIds.includes(context.targetStage.templateStageId)) {
      return [{
        code: 'TRANSITION_NOT_ALLOWED',
        message: `Transition from stage "${currentTemplate.name}" to "${context.targetStage.name}" is not allowed by the workflow template. ` +
                 `Allowed next stages: ${currentTemplate.allowedNextStageIds.join(', ') || '(none)'}.`,
        field: 'targetStageId',
        expectedValue: currentTemplate.allowedNextStageIds,
        actualValue: context.targetStage.templateStageId,
      }];
    }

    return [];
  }

  private checkNoActiveTasks(context: TransitionContext): ValidationError[] {
    const incomplete = context.activeTasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed');
    if (incomplete.length > 0) {
      return incomplete.map(t => ({
        code: 'ACTIVE_TASKS_EXIST',
        message: `Task "${t.title}" (${t.id}) is still in status "${t.status}". All tasks must be completed or cancelled before the stage can advance.`,
        field: 'activeTasks',
        actualValue: t.id,
      }));
    }
    return [];
  }

  private checkRequiredInputArtifacts(context: TransitionContext): ValidationError[] {
    const targetTemplate = this.findStageTemplate(context.template, context.targetStage.templateStageId);
    if (!targetTemplate) {
      return [];
    }

    const errors: ValidationError[] = [];
    for (const requiredType of targetTemplate.requiredInputTypes) {
      const approved = context.artifacts.find(
        a => a.type === requiredType && a.approvalStatus === ArtifactApprovalStatus.Approved
      );
      if (!approved) {
        errors.push({
          code: 'MISSING_INPUT_ARTIFACT',
          message: `Stage "${targetTemplate.name}" requires an approved artifact of type "${requiredType}" before it can start. No such artifact exists in the registry.`,
          field: 'requiredInputTypes',
          expectedValue: requiredType,
        });
      }
    }
    return errors;
  }

  private checkRequiredOutputArtifacts(context: TransitionContext): ValidationError[] {
    const currentTemplate = this.findStageTemplate(context.template, context.currentStage.templateStageId);
    if (!currentTemplate) {
      return [];
    }

    const errors: ValidationError[] = [];
    for (const requiredType of currentTemplate.requiredOutputTypes) {
      const produced = context.artifacts.find(
        a => a.stageId === context.currentStage.id && a.type === requiredType
      );
      if (!produced) {
        errors.push({
          code: 'MISSING_OUTPUT_ARTIFACT',
          message: `Stage "${currentTemplate.name}" must produce an artifact of type "${requiredType}" before it can complete. No such artifact has been registered.`,
          field: 'requiredOutputTypes',
          expectedValue: requiredType,
        });
      }
    }
    return errors;
  }

  private checkNoBlockingBlockers(context: TransitionContext): ValidationError[] {
    const blocking = context.activeBlockers.filter(b => !b.isResolved);
    if (blocking.length > 0) {
      return blocking.map(b => ({
        code: 'UNRESOLVED_BLOCKER',
        message: `Blocker "${b.id}" (severity: ${b.severity}) is unresolved: "${b.reason}". Resolve or escalate all blockers before advancing.`,
        field: 'activeBlockers',
        actualValue: b.id,
      }));
    }
    return [];
  }

  private checkApprovalCheckpoints(context: TransitionContext): ValidationError[] {
    const targetTemplate = this.findStageTemplate(context.template, context.targetStage.templateStageId);
    if (!targetTemplate?.requiresApprovalBeforeStart) {
      return [];
    }

    const checkpoint = context.template.approvalCheckpoints.find(
      c => c.stageId === context.targetStage.templateStageId && c.triggerType === 'before_stage'
    );
    if (!checkpoint) {
      return [];
    }

    if (!context.grantedApprovalCheckpointIds.includes(checkpoint.id)) {
      return [{
        code: 'APPROVAL_REQUIRED',
        message: `Stage "${context.targetStage.name}" requires human approval before it can start (checkpoint: "${checkpoint.description}"). ` +
                 `Grant approval in the workflow UI before proceeding.`,
        field: 'approvalCheckpoints',
        expectedValue: checkpoint.id,
      }];
    }

    return [];
  }

  // ─── Utility ──────────────────────────────────────────────────────────────────

  private findStageTemplate(template: WorkflowTemplate, stageTemplateId: string): StageTemplate | undefined {
    return template.stages.find(s => s.id === stageTemplateId);
  }
}
