// ─── Delegation rule engine (WF-204) ────────────────────────────────────────────
//
// Enforces template-driven agent delegation rules.
// Prevents logically invalid agent invocations, for example:
//   - A coder bypassing the mandatory architecture review stage
//   - A cloud-architect deploying without QA sign-off
//   - A BA directly invoking the advanced-coder without a solution-architect step
//
// Rules are declared in two places:
//   1. WorkflowTemplate.delegationRules  — workflow-wide map: fromAgentId → [allowed toAgentIds]
//   2. StageTemplate.allowedDelegationTargetIds — stage-specific overrides (additive restrictions)
//
// If a `fromAgentId` key is absent from `delegationRules`, any delegation is permitted
// (opt-in restriction model). Stage-level restrictions narrow this further.

import type { WorkflowTemplate } from './WorkflowTemplate';
import type { ValidationResult, ValidationError } from './types';

export interface DelegationContext {
  /** Agent initiating the delegation. */
  fromAgentId: string;
  /** Agent being delegated to. */
  toAgentId: string;
  /** Template governing the current workflow. */
  template: WorkflowTemplate;
  /**
   * Template stage ID in which the from-agent is currently executing.
   * Provide this to enable stage-level delegation checks.
   */
  currentStageTemplateId?: string;
}

export class DelegationRuleEngine {

  /**
   * Validate whether `fromAgent` may delegate to `toAgent` under the given template.
   * Returns a `ValidationResult` — safe to present in the UI.
   */
  validate(context: DelegationContext): ValidationResult {
    const errors: ValidationError[] = [];

    errors.push(...this.checkWorkflowLevelRules(context));

    // Only check stage-level rules if workflow-level rules passed (avoid redundant errors)
    if (errors.length === 0 && context.currentStageTemplateId) {
      errors.push(...this.checkStageLevelRules(context));
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Return a human-readable summary of all permitted delegations for a given agent.
   * Useful for informing the UI or injecting into the agent's context.
   */
  describePermittedDelegations(agentId: string, template: WorkflowTemplate): string {
    const globalRules = template.delegationRules;
    if (!globalRules || !(agentId in globalRules)) {
      return (
        `Agent "${agentId}" has no delegation restrictions in template "${template.id}" ` +
        `(all agents may be targeted at the workflow level).`
      );
    }
    const allowed = globalRules[agentId];
    if (allowed.length === 0) {
      return `Agent "${agentId}" may not delegate to any agent under template "${template.id}".`;
    }
    return `Agent "${agentId}" may delegate to: [${allowed.join(', ')}] under template "${template.id}".`;
  }

  // ─── Private checks ───────────────────────────────────────────────────────────

  private checkWorkflowLevelRules(context: DelegationContext): ValidationError[] {
    const globalRules = context.template.delegationRules;
    if (!globalRules) {
      return [];  // No rules declared — all delegations are permitted at this level
    }

    // If this agent has an explicit entry, enforce it
    if (context.fromAgentId in globalRules) {
      const allowed = globalRules[context.fromAgentId];
      if (!allowed.includes(context.toAgentId)) {
        return [{
          code: 'DELEGATION_NOT_PERMITTED',
          message:
            `Agent "${context.fromAgentId}" is not permitted to delegate to ` +
            `agent "${context.toAgentId}" under workflow template "${context.template.id}". ` +
            `Permitted delegation targets: [${allowed.join(', ') || 'none'}].`,
          field: 'toAgentId',
          expectedValue: allowed,
          actualValue: context.toAgentId,
        }];
      }
    }

    return [];
  }

  private checkStageLevelRules(context: DelegationContext): ValidationError[] {
    if (!context.currentStageTemplateId) {
      return [];
    }

    const stageTemplate = context.template.stages.find(
      s => s.id === context.currentStageTemplateId
    );

    if (!stageTemplate) {
      return [];  // Unknown stage — do not block
    }

    const allowed = stageTemplate.allowedDelegationTargetIds;
    if (!allowed || allowed.length === 0) {
      return [];  // No stage-level restrictions
    }

    if (!allowed.includes(context.toAgentId)) {
      return [{
        code: 'STAGE_DELEGATION_NOT_PERMITTED',
        message:
          `Stage "${stageTemplate.name}" does not allow delegation to agent "${context.toAgentId}". ` +
          `Allowed delegation targets from this stage: [${allowed.join(', ')}].`,
        field: 'toAgentId',
        expectedValue: allowed,
        actualValue: context.toAgentId,
      }];
    }

    return [];
  }
}
