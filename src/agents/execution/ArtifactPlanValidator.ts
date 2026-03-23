/**
 * ArtifactPlanValidator — prevents write target drift.
 *
 * Bug-fix-009 Fix 1.8:
 * When the controller owns an artifact plan (i.e. state.currentPlanId is set),
 * all file writes must target planned artifacts. Writes to unplanned paths
 * are rejected with a descriptive error so the model can self-correct.
 *
 * If no plan is active (currentPlanId is undefined), all writes are allowed —
 * this preserves backward-compat with templates that do not use the queue.
 */

import type { ExecutionStateData } from '../ExecutionStateManager';

// ─── Types re-export (for callers that don't import ExecutionStateManager) ───

export interface PlannedArtifact {
  path: string;
  purpose: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  /** Which requirement / spec item triggered this artifact. */
  sourceRequirement?: string;
}

// ─── Core validation ──────────────────────────────────────────────────────────

/**
 * Returns true if the given path is present in the plan.
 * Path comparison is case-insensitive on Windows, sensitive on POSIX.
 */
export function isWriteAllowedByPlan(
  filePath: string,
  plan: PlannedArtifact[],
): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  return plan.some(a => a.path.replace(/\\/g, '/') === normalised);
}

/**
 * Validate a proposed write against the controller-owned artifact plan.
 *
 * Returns `{ allowed: true }` when:
 *   - the plan is empty (only built-in batch mode uses the plan)
 *   - no plan id is set (template doesn't require plan enforcement)
 *   - the path is listed in remainingArtifacts or completedArtifacts
 *
 * Returns `{ allowed: false, reason: string }` with an actionable message
 * when the path is absent from the plan.
 */
export function validateWriteTarget(
  filePath: string,
  state: ExecutionStateData,
): { allowed: true } | { allowed: false; reason: string } {
  // No plan active — allow all writes
  if (!state.currentPlanId) {
    return { allowed: true };
  }

  const remaining = state.remainingArtifacts ?? [];
  const completed = state.completedArtifacts ?? [];
  const allPlanned: PlannedArtifact[] = [...remaining, ...completed];

  // Plan is active but empty — allow (queue hasn't been populated yet)
  if (allPlanned.length === 0) {
    return { allowed: true };
  }

  if (isWriteAllowedByPlan(filePath, allPlanned)) {
    return { allowed: true };
  }

  const knownPaths = allPlanned.map(a => a.path).join(', ');
  return {
    allowed: false,
    reason:
      `Write target "${filePath}" is not in the controller-owned artifact plan. ` +
      `Planned paths: [${knownPaths}]. ` +
      `Either write to a planned path or call update_task_state to expand the plan first.`,
  };
}

/**
 * Mark an artifact as done in the remaining queue, moving it to completed.
 *
 * This is a pure state-transform helper — it does not persist state.
 * The caller must call ExecutionStateManager.save() after using this.
 */
export function markArtifactDone(
  filePath: string,
  state: ExecutionStateData,
): void {
  const normalised = filePath.replace(/\\/g, '/');
  const remaining = state.remainingArtifacts ?? [];
  const done = remaining.find(a => a.path.replace(/\\/g, '/') === normalised);

  if (done) {
    state.remainingArtifacts = remaining.filter(
      a => a.path.replace(/\\/g, '/') !== normalised,
    );
    state.completedArtifacts = [
      ...(state.completedArtifacts ?? []),
      { ...done, status: 'done' },
    ];
  }
}

/**
 * Expand the plan by adding a new planned artifact if it is not already present.
 *
 * Use when the model discovers that an unplanned file is needed (e.g. a shared
 * utility). The controller explicitly approves the expansion by calling this.
 */
export function expandPlan(
  artifact: PlannedArtifact,
  state: ExecutionStateData,
): void {
  const existing = [...(state.remainingArtifacts ?? []), ...(state.completedArtifacts ?? [])];
  if (!isWriteAllowedByPlan(artifact.path, existing)) {
    state.remainingArtifacts = [...(state.remainingArtifacts ?? []), artifact];
  }
}
