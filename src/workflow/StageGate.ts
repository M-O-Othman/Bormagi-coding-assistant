// ─── Stage gate (WF-301 / WF-302) ───────────────────────────────────────────────
//
// WF-301: Required-input checks per stage.
//   Block stage START when prerequisite artifacts are missing.
//
// WF-302: Required-output checks per stage.
//   Block stage COMPLETE when required output artifacts have not been produced.
//
// `StageGate` is a deterministic, stateless validator. It does NOT modify any state
// and can be safely called from the CLI, the WorkflowEngine, and the UI.
//
// All errors include:
//   - A machine-readable `code` for programmatic handling
//   - A human-readable `message` explaining what is missing and why
//   - Optional `field`, `expectedValue`, and `actualValue` for structured display

import { ArtifactApprovalStatus } from './enums';
import type { Artifact, ValidationResult, ValidationError } from './types';
import type { StageTemplate } from './WorkflowTemplate';

export interface StageGateContext {
  /** The template describing the gate's rules. */
  stageTemplate: StageTemplate;
  /** All workflow artifacts available at gate-check time. */
  artifacts: Artifact[];
  /** IDs of approval checkpoints already granted for this workflow. */
  grantedApprovalCheckpointIds: string[];
}

/** Summary report produced by checkExit(). */
export interface StageCompletionReport {
  stageName: string;
  requiredOutputTypes: string[];
  produced: { type: string; artifactName: string; status: string }[];
  missing: string[];
  isComplete: boolean;
}

export class StageGate {

  // ─── WF-301: Entry gate ───────────────────────────────────────────────────────

  /**
   * Verify all required inputs are present and approved before a stage may start.
   * Reusable from both the engine (enforcement) and the UI (informational display).
   */
  checkEntry(context: StageGateContext): ValidationResult {
    const errors: ValidationError[] = [];
    errors.push(...this.verifyRequiredInputArtifacts(context));
    return { isValid: errors.length === 0, errors };
  }

  // ─── WF-302: Exit gate ────────────────────────────────────────────────────────

  /**
   * Verify all required outputs have been produced before a stage may complete.
   * A produced artifact must be at least submitted (not in draft) to satisfy the check.
   */
  checkExit(context: StageGateContext): ValidationResult {
    const errors: ValidationError[] = [];
    errors.push(...this.verifyRequiredOutputArtifacts(context));
    return { isValid: errors.length === 0, errors };
  }

  /**
   * Run both entry and exit checks and return all errors together.
   * Useful for generating a "what is blocking progress?" summary panel.
   */
  checkAll(context: StageGateContext): ValidationResult {
    const errors: ValidationError[] = [
      ...this.checkEntry(context).errors,
      ...this.checkExit(context).errors,
    ];
    return { isValid: errors.length === 0, errors };
  }

  /**
   * Build a human-readable completion report for a stage's required outputs.
   * Surfaced in the workflow panel to help users track what remains.
   */
  buildCompletionReport(context: StageGateContext): StageCompletionReport {
    const produced: StageCompletionReport['produced'] = [];
    const missing: string[] = [];

    for (const requiredType of context.stageTemplate.requiredOutputTypes) {
      const artifact = context.artifacts.find(a => a.type === requiredType);
      if (artifact) {
        produced.push({
          type: requiredType,
          artifactName: artifact.name,
          status: artifact.approvalStatus,
        });
      } else {
        missing.push(requiredType);
      }
    }

    return {
      stageName: context.stageTemplate.name,
      requiredOutputTypes: context.stageTemplate.requiredOutputTypes,
      produced,
      missing,
      isComplete: missing.length === 0,
    };
  }

  // ─── Private checks ───────────────────────────────────────────────────────────

  /** WF-301 — required input artifact types must exist and be approved. */
  private verifyRequiredInputArtifacts(context: StageGateContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const requiredType of context.stageTemplate.requiredInputTypes) {
      const approved = context.artifacts.find(
        a => a.type === requiredType && a.approvalStatus === ArtifactApprovalStatus.Approved
      );
      if (!approved) {
        // Check if it exists but is not yet approved
        const exists = context.artifacts.find(a => a.type === requiredType);
        const detail = exists
          ? ` (found "${exists.name}" with status "${exists.approvalStatus}" — approval required)`
          : ' (no artifact of this type has been registered)';

        errors.push({
          code: 'MISSING_REQUIRED_INPUT',
          message:
            `Stage "${context.stageTemplate.name}" cannot start: ` +
            `no approved artifact of type "${requiredType}" found${detail}. ` +
            `Ensure the preceding stage has produced and approved this artifact.`,
          field: 'requiredInputTypes',
          expectedValue: requiredType,
          actualValue: exists?.approvalStatus ?? 'not found',
        });
      }
    }

    return errors;
  }

  /** WF-302 — required output artifact types must have been produced (submitted or approved). */
  private verifyRequiredOutputArtifacts(context: StageGateContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const requiredType of context.stageTemplate.requiredOutputTypes) {
      const artifact = context.artifacts.find(a => a.type === requiredType);

      if (!artifact) {
        errors.push({
          code: 'MISSING_REQUIRED_OUTPUT',
          message:
            `Stage "${context.stageTemplate.name}" cannot complete: ` +
            `no artifact of type "${requiredType}" has been produced. ` +
            `This stage must produce this output before it can be marked as complete.`,
          field: 'requiredOutputTypes',
          expectedValue: requiredType,
        });
      } else if (artifact.approvalStatus === ArtifactApprovalStatus.Draft) {
        errors.push({
          code: 'OUTPUT_NOT_SUBMITTED',
          message:
            `Stage "${context.stageTemplate.name}" cannot complete: ` +
            `artifact "${artifact.name}" (type: "${requiredType}") is still in Draft status. ` +
            `Submit or approve the artifact before marking the stage as complete.`,
          field: 'requiredOutputTypes',
          expectedValue: ArtifactApprovalStatus.Submitted,
          actualValue: artifact.approvalStatus,
        });
      }
    }

    return errors;
  }
}
