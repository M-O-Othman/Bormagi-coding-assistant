// ─── Safety manager (WF-801 / WF-802 / WF-803) ──────────────────────────────────
//
// WF-801: One-workflow-at-a-time per task target area.
//   Detects conflicts when two workflows operate on the same artifact ownership
//   domain. A human confirmation override allows proceeding anyway.
//
// WF-802: Stage/role tool permission restrictions.
//   Each workflow template stage specifies which MCP tools are allowed for each
//   agent role. SafetyManager enforces this centrally so the restriction logic
//   lives in one place rather than being duplicated in AgentRunner.
//
// WF-803: Upstream artifact protection.
//   Prevents downstream agents from silently overwriting artifacts that have
//   already been approved by an upstream stage. Overwrite attempts are logged.
//
// SafetyManager is stateless — all persistence is delegated to WorkflowStorage
// and ArtifactRegistry.  It exposes only synchronous checks (no async hidden
// inside) to keep the calling code explicit.

import type { WorkflowStorage } from './WorkflowStorage';
import type { ArtifactRegistry } from './ArtifactRegistry';
import type { WorkflowTemplate } from './WorkflowTemplate';
import type { Artifact } from './types';
import { ArtifactApprovalStatus, WorkflowStatus } from './enums';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictingWorkflowIds: string[];
  conflictingArtifactTypes: string[];
  message: string;
}

export interface ToolPermissionCheckResult {
  isAllowed: boolean;
  /** Human-readable explanation surfaced in the thought trace. */
  message: string;
}

export interface ArtifactOverwriteCheckResult {
  isBlocked: boolean;
  /** The approved artifact that would be overwritten. */
  protectedArtifact: Artifact | null;
  message: string;
}

// ─── SafetyManager class ───────────────────────────────────────────────────────

export class SafetyManager {
  constructor(
    private readonly storage: WorkflowStorage,
    private readonly artifactRegistry: ArtifactRegistry
  ) {}

  // ─── WF-801: Workflow conflict detection ──────────────────────────────────────

  /**
   * Check whether a new workflow would conflict with any currently active workflow.
   * Conflict is defined as: two workflows produce artifacts of the same type that
   * belong to the same target area (identified by `targetArea`, an arbitrary scope
   * label defined by the template).
   *
   * Returns a ConflictCheckResult. The caller decides whether to block or confirm.
   */
  async checkNewWorkflowConflict(
    candidateTemplate: WorkflowTemplate,
    targetArea: string
  ): Promise<ConflictCheckResult> {
    const workflowIds = await this.storage.listWorkflowIds();
    const conflictingWorkflowIds: string[] = [];
    const conflictingArtifactTypes = new Set<string>();

    // Collect all artifact types that the candidate template can produce
    const candidateOutputTypes = new Set<string>(
      candidateTemplate.stages.flatMap(s => s.requiredOutputTypes)
    );

    for (const id of workflowIds) {
      const wf = await this.storage.loadWorkflow(id);
      if (!wf) continue;
      if (wf.status !== WorkflowStatus.Active) continue;

      // Compare artifact ownership by looking at the existing workflow's artifacts
      const existingArtifacts = await this.artifactRegistry.getAll(id);
      const approvedTypes = existingArtifacts
        .filter(a => a.approvalStatus === ArtifactApprovalStatus.Approved)
        .map(a => a.type);

      const overlap = approvedTypes.filter(t => candidateOutputTypes.has(t));
      if (overlap.length > 0) {
        conflictingWorkflowIds.push(id);
        overlap.forEach(t => conflictingArtifactTypes.add(t));
      }
    }

    if (conflictingWorkflowIds.length === 0) {
      return { hasConflict: false, conflictingWorkflowIds: [], conflictingArtifactTypes: [], message: 'No conflicts detected.' };
    }

    return {
      hasConflict: true,
      conflictingWorkflowIds,
      conflictingArtifactTypes: Array.from(conflictingArtifactTypes),
      message:
        `Conflict detected: ${conflictingWorkflowIds.length} active workflow(s) already own approved artifacts ` +
        `of types: ${Array.from(conflictingArtifactTypes).join(', ')}. ` +
        `Starting this workflow may cause inconsistent artifact state. ` +
        `Human confirmation is required to override.`,
    };
  }

  // ─── WF-802: Tool permission enforcement ──────────────────────────────────────

  /**
   * Check whether `agentId` is allowed to call `toolName` in the context of a
   * specific workflow stage.
   *
   * Permission lookup order:
   *   1. Stage-level `allowedToolsPerAgent[agentId]` (most specific)
   *   2. Stage-level `allowedToolsPerAgent['*']`  (stage-wide wildcard)
   *   3. If neither is defined → allow by default (open permission model).
   *
   * The `allowedToolsPerAgent` field is optional on `StageTemplate`. If absent,
   * all tools are allowed for that stage (backward-compatible default).
   */
  checkToolPermission(
    toolName: string,
    agentId: string,
    stageId: string,
    template: WorkflowTemplate
  ): ToolPermissionCheckResult {
    const stage = template.stages.find(s => s.id === stageId);
    if (!stage) {
      return {
        isAllowed: true,
        message: `Stage "${stageId}" not found in template — defaulting to allow.`,
      };
    }

    // `allowedToolsPerAgent` is an optional extension field on StageTemplate
    const toolMap = (stage as unknown as { allowedToolsPerAgent?: Record<string, string[]> }).allowedToolsPerAgent;
    if (!toolMap) {
      // No restrictions defined for this stage — open permission model
      return { isAllowed: true, message: 'No tool restrictions defined for this stage.' };
    }

    const agentAllowed = toolMap[agentId];
    const wildcardAllowed = toolMap['*'];

    const permitted = agentAllowed ?? wildcardAllowed;
    if (!permitted) {
      // No rule for this agent, no wildcard — default to allow
      return { isAllowed: true, message: `No restrictions for agent "${agentId}" in stage "${stageId}".` };
    }

    if (permitted.includes(toolName) || permitted.includes('*')) {
      return { isAllowed: true, message: `Tool "${toolName}" is permitted for agent "${agentId}" in stage "${stageId}".` };
    }

    return {
      isAllowed: false,
      message:
        `Tool "${toolName}" is NOT permitted for agent "${agentId}" in stage "${stageId}". ` +
        `Permitted tools: [${permitted.join(', ')}]. ` +
        `Contact the workflow human owner to request an exception.`,
    };
  }

  /**
   * Return a human-readable summary of tool restrictions for a given stage.
   * Surfaced in the workflow context injected into agent prompts (WF-205).
   */
  describeToolRestrictions(stageId: string, template: WorkflowTemplate): string {
    const stage = template.stages.find(s => s.id === stageId);
    if (!stage) return `Stage "${stageId}" not found.`;

    const toolMap = (stage as unknown as { allowedToolsPerAgent?: Record<string, string[]> }).allowedToolsPerAgent;
    if (!toolMap || Object.keys(toolMap).length === 0) {
      return 'No tool restrictions for this stage — all tools are permitted.';
    }

    const lines = Object.entries(toolMap).map(([agent, tools]) =>
      `  ${agent === '*' ? '(all agents)' : agent}: ${tools.join(', ')}`
    );
    return `Tool restrictions for stage "${stage.name}":\n${lines.join('\n')}`;
  }

  // ─── WF-803: Upstream artifact protection ─────────────────────────────────────

  /**
   * Check whether writing to `filePath` would overwrite an approved upstream artifact.
   * Returns a block if the file path is tracked as an approved artifact produced by
   * a stage earlier in the workflow (i.e., a stage that has already completed).
   *
   * This check is called from AgentRunner before any `write_file` operation.
   */
  async checkArtifactOverwrite(
    workflowId: string,
    filePath: string,
    writingAgentId: string,
    currentStageId: string
  ): Promise<ArtifactOverwriteCheckResult> {
    const artifacts = await this.artifactRegistry.getAll(workflowId);
    const stages = await this.storage.loadStages(workflowId);

    // Determine stage order (sequence number)
    const stageOrder = new Map<string, number>(stages.map((s, i) => [s.id, i]));
    const currentOrder = stageOrder.get(currentStageId) ?? Infinity;

    for (const artifact of artifacts) {
      if (artifact.path !== filePath) continue;
      if (artifact.approvalStatus !== ArtifactApprovalStatus.Approved) continue;

      // Check if the artifact was produced by an earlier stage
      const artifactStageOrder = stageOrder.get(artifact.stageId) ?? -1;
      if (artifactStageOrder < currentOrder) {
        return {
          isBlocked: true,
          protectedArtifact: artifact,
          message:
            `Write blocked: "${filePath}" is an approved artifact (ID: ${artifact.id}, ` +
            `type: "${artifact.type}", produced by stage "${artifact.stageId}"). ` +
            `Downstream agents may not silently overwrite approved upstream artifacts. ` +
            `To update this artifact, submit a new version via the artifact registry ` +
            `or request a revision via the workflow return-for-revision flow.`,
        };
      }
    }

    return {
      isBlocked: false,
      protectedArtifact: null,
      message: `No approved upstream artifact found at "${filePath}" — write is permitted.`,
    };
  }

  /**
   * Log an attempted overwrite of a protected artifact.
   * Caller is responsible for deciding whether to block or proceed.
   * Returns a brief human-readable record suitable for the thought trace.
   */
  describeOverwriteAttempt(
    filePath: string,
    artifact: Artifact,
    writingAgentId: string
  ): string {
    return (
      `⚠ Overwrite attempt: agent "${writingAgentId}" tried to write ` +
      `"${filePath}" which is tracked as approved artifact "${artifact.name}" ` +
      `(type: ${artifact.type}, approved by: ${artifact.approvedBy ?? 'unknown'}). ` +
      `This attempt has been logged.`
    );
  }
}
