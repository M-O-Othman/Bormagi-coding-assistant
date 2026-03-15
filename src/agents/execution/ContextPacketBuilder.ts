import type { ExecutionStateData, ContextPacket, ResolvedInputSummary } from '../ExecutionStateManager';
import { buildWorkspaceSummary } from './PromptAssembler';

/**
 * Builds a compact context packet from ExecutionStateData (DD7).
 *
 * The packet contains only the minimum information needed for the next
 * LLM call — objective, phase, next action, resolved input summaries
 * (not full file contents), and recent artifacts.
 *
 * Used by PromptAssembler to construct per-turn prompts without replaying
 * raw transcript history.
 */
export class ContextPacketBuilder {
  /**
   * Build a compact context packet from the current execution state.
   *
   * @param state - Current execution state
   * @param workspaceType - Classified workspace type
   * @param lastToolResult - Result from the most recent tool dispatch (truncated)
   * @param currentInstruction - Current user message or objective
   */
  build(
    state: ExecutionStateData,
    workspaceType: 'greenfield' | 'scaffolded' | 'mature',
    lastToolResult?: string,
    currentInstruction?: string,
  ): ContextPacketOutput {
    // Build compact state summary
    const lines: string[] = [
      `Objective: ${state.objective.slice(0, 200)}`,
      `Mode: ${state.mode} | Iterations: ${state.iterationsUsed}`,
    ];

    if (state.approvedPlanPath) {
      lines.push(`Approved plan: ${state.approvedPlanPath}`);
    }

    if (state.techStack && Object.keys(state.techStack).length > 0) {
      lines.push(`Tech stack: ${JSON.stringify(state.techStack)}`);
    }

    if (state.artifactsCreated.length > 0) {
      const files = state.artifactsCreated.slice(-5);
      lines.push(`Files written: ${files.join(', ')}${state.artifactsCreated.length > 5 ? ` (+${state.artifactsCreated.length - 5} more)` : ''}`);
    }

    if (state.nextActions.length > 0) {
      lines.push(`Next: ${state.nextActions[0]}`);
    }

    const planned = state.plannedFileBatch ?? [];
    if (planned.length > 0) {
      const completed = state.completedBatchFiles ?? [];
      const remaining = planned.filter(f => !completed.includes(f));
      if (remaining.length > 0) {
        lines.push(`Batch remaining: ${remaining.slice(0, 3).join(', ')}${remaining.length > 3 ? ` +${remaining.length - 3} more` : ''}`);
      }
    }

    // Top 3 resolved input summaries (not full contents)
    const summaries = (state.resolvedInputSummaries ?? []).slice(-3);
    if (summaries.length > 0) {
      lines.push(`Resolved inputs: ${summaries.map(s => `${s.path} (${s.kind})`).join(', ')}`);
    }

    const stateSummary = lines.join('\n');
    const workspaceSummary = buildWorkspaceSummary(workspaceType, state.artifactsCreated.slice(-3));

    return {
      stateSummary,
      workspaceSummary,
      resolvedInputSummaries: summaries,
      nextAction: state.nextActions[0],
      nextToolCallDescription: state.nextToolCall?.description,
      estimatedTokens: Math.ceil(stateSummary.length / 4) + Math.ceil(workspaceSummary.length / 4),
    };
  }
}

export interface ContextPacketOutput {
  stateSummary: string;
  workspaceSummary: string;
  resolvedInputSummaries: ResolvedInputSummary[];
  nextAction?: string;
  nextToolCallDescription?: string;
  estimatedTokens: number;
}
