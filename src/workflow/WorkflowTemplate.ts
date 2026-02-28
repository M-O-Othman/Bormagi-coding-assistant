// ─── Workflow template schema and validation (WF-005) ──────────────────────────
//
// Defines the structure for workflow templates and validates template objects
// at runtime before they are used to create workflow instances.
//
// Templates are loaded from JSON files under predefined-workflows/ in the
// extension package, or from .bormagi/workflow-templates/ in a workspace.

import type { ValidationResult, ValidationError } from './types';

// ─── Template types ─────────────────────────────────────────────────────────────

export interface StageTemplate {
  /** Stable identifier used as stageId in workflow instances. */
  id: string;
  name: string;
  description: string;
  /** agentId of the agent that owns this stage. */
  ownerAgentId: string;
  /** Sequence position (1-based). */
  sequence: number;
  /**
   * Artifact types that must be registered and approved before this stage
   * may start.  Values are artifact type strings (e.g. 'requirements').
   */
  requiredInputTypes: string[];
  /**
   * Artifact types that must be registered before this stage may be marked
   * complete.
   */
  requiredOutputTypes: string[];
  /** Stage IDs this stage may transition to on successful completion. */
  allowedNextStageIds: string[];
  /** Stage IDs this stage may fall back to (e.g. to return work upstream). */
  allowedFallbackStageIds: string[];
  /** Agent IDs this stage may delegate tasks to. */
  allowedDelegationTargetIds: string[];
  /**
   * Free-text entry rules checked before the stage starts.
   * Used for documentation and UI display; machine checks use requiredInputTypes.
   */
  entryRules: string[];
  /**
   * Free-text exit rules checked before the stage completes.
   * Used for documentation and UI display; machine checks use requiredOutputTypes.
   */
  exitRules: string[];
  /** Whether a human approval checkpoint is required before this stage starts. */
  requiresApprovalBeforeStart: boolean;
  /** Whether a human approval checkpoint is required before this stage completes. */
  requiresApprovalBeforeComplete: boolean;
}

export interface ApprovalCheckpoint {
  id: string;
  /** 'before_stage' | 'before_completion' */
  triggerType: 'before_stage' | 'before_completion';
  stageId: string;
  description: string;
}

export interface WorkflowTemplate {
  /** Unique stable identifier for this template. */
  id: string;
  name: string;
  description: string;
  version: string;   // semver string
  stages: StageTemplate[];
  /** Agent ID that starts the first task when the workflow is created. */
  initialAgentId: string;
  /** Stage ID to use when the workflow is created. */
  initialStageId: string;
  approvalCheckpoints: ApprovalCheckpoint[];
  /** Template-level delegation rules: key = from-agentId, value = allowed to-agentIds. */
  delegationRules: Record<string, string[]>;
  metadata: Record<string, unknown>;
}

// ─── Template validator ─────────────────────────────────────────────────────────

export function validateTemplate(template: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!template || typeof template !== 'object') {
    return { isValid: false, errors: [{ code: 'INVALID_TYPE', message: 'Template must be a non-null object.' }] };
  }

  const t = template as Record<string, unknown>;

  // Required top-level string fields.
  for (const field of ['id', 'name', 'description', 'version', 'initialAgentId', 'initialStageId'] as const) {
    if (!t[field] || typeof t[field] !== 'string') {
      errors.push({ code: 'MISSING_FIELD', message: `Template field "${field}" is required and must be a non-empty string.`, field });
    }
  }

  // Stages array.
  if (!Array.isArray(t.stages) || t.stages.length === 0) {
    errors.push({ code: 'MISSING_FIELD', message: 'Template must have at least one stage in the "stages" array.', field: 'stages' });
  } else {
    const stageIds = new Set<string>();
    for (let i = 0; i < (t.stages as unknown[]).length; i++) {
      const stageErrors = validateStageTemplate(t.stages[i] as Record<string, unknown>, i);
      errors.push(...stageErrors);
      const stage = t.stages[i] as Record<string, unknown>;
      if (typeof stage.id === 'string') {
        if (stageIds.has(stage.id)) {
          errors.push({ code: 'DUPLICATE_STAGE_ID', message: `Stage id "${stage.id}" is duplicated.`, field: `stages[${i}].id` });
        }
        stageIds.add(stage.id);
      }
    }

    // Validate that initialStageId references a real stage.
    if (typeof t.initialStageId === 'string' && !stageIds.has(t.initialStageId)) {
      errors.push({ code: 'INVALID_REFERENCE', message: `initialStageId "${t.initialStageId}" does not match any stage id.`, field: 'initialStageId' });
    }

    // Validate that allowedNextStageIds reference real stages.
    for (let i = 0; i < (t.stages as unknown[]).length; i++) {
      const stage = t.stages[i] as Record<string, unknown>;
      for (const nextId of (stage.allowedNextStageIds as string[] | undefined) ?? []) {
        if (!stageIds.has(nextId)) {
          errors.push({ code: 'INVALID_REFERENCE', message: `stages[${i}].allowedNextStageIds references unknown stage "${nextId}".`, field: `stages[${i}].allowedNextStageIds` });
        }
      }
    }
  }

  return { isValid: errors.length === 0, errors };
}

function validateStageTemplate(stage: Record<string, unknown>, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `stages[${index}]`;

  for (const field of ['id', 'name', 'description', 'ownerAgentId'] as const) {
    if (!stage[field] || typeof stage[field] !== 'string') {
      errors.push({ code: 'MISSING_FIELD', message: `${prefix}.${field} is required and must be a non-empty string.`, field: `${prefix}.${field}` });
    }
  }

  if (typeof stage.sequence !== 'number' || !Number.isInteger(stage.sequence) || stage.sequence < 1) {
    errors.push({ code: 'INVALID_VALUE', message: `${prefix}.sequence must be a positive integer.`, field: `${prefix}.sequence` });
  }

  for (const field of ['requiredInputTypes', 'requiredOutputTypes', 'allowedNextStageIds', 'allowedFallbackStageIds', 'allowedDelegationTargetIds', 'entryRules', 'exitRules'] as const) {
    if (!Array.isArray(stage[field])) {
      errors.push({ code: 'INVALID_TYPE', message: `${prefix}.${field} must be an array.`, field: `${prefix}.${field}` });
    }
  }

  return errors;
}

// ─── Template loader ────────────────────────────────────────────────────────────

/**
 * Parse and validate a workflow template from raw JSON.
 * Throws with a descriptive message if the template fails validation.
 */
export function parseTemplate(raw: string, sourcePath: string): WorkflowTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse workflow template at "${sourcePath}": ${(err as Error).message}`);
  }

  const result = validateTemplate(parsed);
  if (!result.isValid) {
    const errorLines = result.errors.map(e => `  - [${e.code}] ${e.message}`).join('\n');
    throw new Error(`Workflow template at "${sourcePath}" failed validation:\n${errorLines}`);
  }

  return parsed as WorkflowTemplate;
}

/** Serialise a WorkflowTemplate to a formatted JSON string. */
export function serialiseTemplate(template: WorkflowTemplate): string {
  return JSON.stringify(template, null, 2);
}
