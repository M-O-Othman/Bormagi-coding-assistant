// ─── Workflow context builder (WF-205) ──────────────────────────────────────────
//
// Builds a rich, deterministic context section for delegated agent tasks.
// Injected at the start of the delegated agent's system prompt so the agent
// does NOT depend on raw prior chat history alone.
//
// Context includes:
//   - The handoff request (objective, constraints, expected outputs, done criteria)
//   - Input artifacts from the artifact registry with path and status
//   - Relevant decisions from the decision log
//   - Active (unresolved) blockers
//   - Current stage and workflow state
//
// Output is Markdown — ready to prepend to a system prompt or inject as a user
// message. The output is deterministic and independently testable.

import type { HandoffRequest, Artifact, DecisionLogEntry, Blocker, WorkflowStage } from './types';
import type { WorkflowStorage } from './WorkflowStorage';
import type { ArtifactRegistry } from './ArtifactRegistry';

export interface WorkflowContextSnapshot {
  handoff: HandoffRequest;
  /** Artifacts referenced by the handoff's inputArtifactIds. */
  artifacts: Artifact[];
  /** Decision log entries referenced by the handoff's relevantDecisionIds. */
  decisions: DecisionLogEntry[];
  /** All unresolved blockers for the workflow. */
  blockers: Blocker[];
  /** The current active stage, or null if unknown. */
  currentStage: WorkflowStage | null;
  /** Tool names the delegated agent is permitted to call. Empty = no restriction. */
  allowedTools: string[];
}

export class WorkflowContextBuilder {
  constructor(
    private readonly storage: WorkflowStorage,
    private readonly artifactRegistry: ArtifactRegistry
  ) {}

  // ─── Snapshot assembly ────────────────────────────────────────────────────────

  /**
   * Load all data referenced by a handoff and return a WorkflowContextSnapshot.
   * Returns null if the handoff is not found.
   */
  async buildSnapshot(workflowId: string, handoffId: string): Promise<WorkflowContextSnapshot | null> {
    const handoffs = await this.storage.loadHandoffSnapshots(workflowId);
    const handoff = handoffs.find(h => h.id === handoffId);
    if (!handoff) {
      return null;
    }

    // Resolve referenced artifacts by ID
    const allArtifacts = await this.artifactRegistry.getAll(workflowId);
    const artifacts = handoff.inputArtifactIds
      .map(id => allArtifacts.find(a => a.id === id))
      .filter((a): a is Artifact => a !== undefined);

    // Load relevant decisions
    const allDecisions = await this.storage.loadDecisions(workflowId);
    const decisions = handoff.relevantDecisionIds.length > 0
      ? allDecisions.filter(d => handoff.relevantDecisionIds.includes(d.id))
      : [];

    // Active blockers only
    const allBlockers = await this.storage.loadBlockers(workflowId);
    const blockers = allBlockers.filter(b => !b.isResolved);

    // Current stage from workflow snapshot
    const stages = await this.storage.loadStages(workflowId);
    const workflow = await this.storage.loadWorkflow(workflowId);
    const currentStage = workflow?.currentStageId
      ? (stages.find(s => s.id === workflow.currentStageId) ?? null)
      : null;

    return {
      handoff,
      artifacts,
      decisions,
      blockers,
      currentStage,
      allowedTools: [],
    };
  }

  // ─── Rendering ────────────────────────────────────────────────────────────────

  /**
   * Render a WorkflowContextSnapshot as a Markdown block for system-prompt injection.
   * The block is enclosed in a clear header/footer so agents can identify it.
   */
  renderContextSection(snapshot: WorkflowContextSnapshot): string {
    const lines: string[] = [];

    lines.push('<!-- BEGIN WORKFLOW CONTEXT — injected by WorkflowContextBuilder -->');
    lines.push('## Workflow Context');
    lines.push('');
    lines.push('> This section was generated automatically and describes the task delegated to you.');
    lines.push('> Preserve this section verbatim during context compression.');
    lines.push('');

    // ── Handoff ────────────────────────────────────────────────────────────────
    lines.push('### Task Handoff');
    lines.push(`- **From Agent:** \`${snapshot.handoff.fromAgentId}\``);
    lines.push(`- **To Agent:** \`${snapshot.handoff.toAgentId}\``);
    lines.push(`- **Objective:** ${snapshot.handoff.objective}`);
    lines.push(`- **Reason for Handoff:** ${snapshot.handoff.reasonForHandoff}`);

    if (snapshot.handoff.constraints.length > 0) {
      lines.push('- **Constraints:**');
      snapshot.handoff.constraints.forEach(c => lines.push(`  - ${c}`));
    }
    if (snapshot.handoff.expectedOutputs.length > 0) {
      lines.push('- **Expected Outputs:**');
      snapshot.handoff.expectedOutputs.forEach(o => lines.push(`  - ${o}`));
    }
    if (snapshot.handoff.doneCriteria.length > 0) {
      lines.push('- **Done Criteria:**');
      snapshot.handoff.doneCriteria.forEach(d => lines.push(`  - ${d}`));
    }
    if (snapshot.handoff.returnToAgentId) {
      lines.push(`- **Return to Agent:** \`${snapshot.handoff.returnToAgentId}\` (after task completes)`);
    }
    lines.push('');

    // ── Artifacts ──────────────────────────────────────────────────────────────
    if (snapshot.artifacts.length > 0) {
      lines.push('### Input Artifacts');
      for (const a of snapshot.artifacts) {
        lines.push(`#### ${a.name} (v${a.version})`);
        lines.push(`- **Type:** \`${a.type}\``);
        lines.push(`- **Status:** ${a.approvalStatus}`);
        lines.push(`- **Path:** \`${a.path}\``);
        if (a.description) {
          lines.push(`- ${a.description}`);
        }
      }
      lines.push('');
    }

    // ── Decisions ──────────────────────────────────────────────────────────────
    if (snapshot.decisions.length > 0) {
      lines.push('### Relevant Decisions');
      for (const d of snapshot.decisions) {
        lines.push(`#### ${d.title}`);
        lines.push(`- **Owner:** \`${d.ownerAgentId}\``);
        lines.push(`- **Rationale:** ${d.rationale}`);
        if (d.impact) {
          lines.push(`- **Impact:** ${d.impact}`);
        }
        if (d.alternativesConsidered.length > 0) {
          lines.push('- **Alternatives Considered:**');
          d.alternativesConsidered.forEach(a => lines.push(`  - ${a}`));
        }
      }
      lines.push('');
    }

    // ── Active blockers ────────────────────────────────────────────────────────
    if (snapshot.blockers.length > 0) {
      lines.push('### Active Blockers');
      for (const b of snapshot.blockers) {
        lines.push(`- **[${b.severity.toUpperCase()}]** ${b.reason}`);
        if (b.suggestedRoute) {
          lines.push(`  - Suggested route: ${b.suggestedRoute}`);
        }
        if (b.isEscalated) {
          lines.push('  - ⚠ This blocker has been escalated to the human owner.');
        }
      }
      lines.push('');
    }

    // ── Current stage ──────────────────────────────────────────────────────────
    if (snapshot.currentStage) {
      lines.push('### Current Stage');
      lines.push(`- **Stage:** ${snapshot.currentStage.name}`);
      lines.push(`- **Status:** ${snapshot.currentStage.status}`);
      lines.push(`- **Owner Agent:** \`${snapshot.currentStage.ownerAgentId}\``);
      lines.push('');
    }

    lines.push('<!-- END WORKFLOW CONTEXT -->');
    return lines.join('\n');
  }
}
