// ─── Session Checkpoint ───────────────────────────────────────────────────────
//
// Persists and restores a lightweight session snapshot so that sessions can be
// resumed after a restart without losing context.
//
// Stored at:  .bormagi/checkpoints/<session-id>.json
//
// The checkpoint captures:
//   - activeMode           — the mode the agent was operating in
//   - compactedSummary     — the latest CompactedHistory (if compaction ran)
//   - currentPlan          — ordered list of pending steps
//   - recentEditedFiles    — the last N edited paths
//   - lastValidatedStateUtc — ISO timestamp of the last successful validation
//   - pendingToolArtifacts  — IDs of tool results not yet flushed to memory
//   - savedAtUtc           — when the checkpoint was written
//
// Spec reference: §FR-9 (OQ answer: workspace-local JSON, per §28 answer 4).

import * as fs from 'fs';
import * as path from 'path';
import type { CheckpointState } from '../context/types';

// ─── Storage ──────────────────────────────────────────────────────────────────

function checkpointDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.bormagi', 'checkpoints');
}

function checkpointPath(workspaceRoot: string, sessionId: string): string {
  // Sanitise the session ID so it is safe as a filename.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(checkpointDir(workspaceRoot), `${safe}.json`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist a session checkpoint to disk.
 *
 * The checkpoint is written atomically (write to `.tmp` then rename) so a
 * crash mid-write cannot corrupt the previous valid checkpoint.
 *
 * @param workspaceRoot  Absolute workspace root.
 * @param state          Checkpoint data to persist.
 */
export async function saveCheckpoint(
  workspaceRoot: string,
  state: CheckpointState,
): Promise<void> {
  const dir  = checkpointDir(workspaceRoot);
  const dest = checkpointPath(workspaceRoot, state.sessionId);
  const tmp  = `${dest}.tmp`;

  fs.mkdirSync(dir, { recursive: true });
  const payload: CheckpointState = {
    ...state,
    savedAtUtc: new Date().toISOString(),
  };

  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, dest);
}

/**
 * Load the checkpoint for a session.
 *
 * @param workspaceRoot  Absolute workspace root.
 * @param sessionId      Session identifier.
 * @returns              Parsed `CheckpointState`, or `null` when not found or corrupt.
 */
export async function loadCheckpoint(
  workspaceRoot: string,
  sessionId: string,
): Promise<CheckpointState | null> {
  const filePath = checkpointPath(workspaceRoot, sessionId);
  if (!fs.existsSync(filePath)) { return null; }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CheckpointState;
  } catch {
    return null;
  }
}

/**
 * List all checkpoint session IDs for the workspace.
 *
 * Useful for a "resume session" picker in the UI.
 *
 * @param workspaceRoot  Absolute workspace root.
 * @returns              Array of session IDs, newest first.
 */
export function listCheckpoints(workspaceRoot: string): string[] {
  const dir = checkpointDir(workspaceRoot);
  if (!fs.existsSync(dir)) { return []; }
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort()
      .reverse()
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * Delete the checkpoint for a session (e.g. after clean completion).
 *
 * @param workspaceRoot  Absolute workspace root.
 * @param sessionId      Session identifier.
 */
export function deleteCheckpoint(workspaceRoot: string, sessionId: string): void {
  const filePath = checkpointPath(workspaceRoot, sessionId);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

/**
 * Build a minimal checkpoint state from the runtime fields available at the
 * end of an `AgentRunner.run()` invocation.
 */
export function buildCheckpointState(
  sessionId: string,
  fields: Omit<CheckpointState, 'sessionId' | 'savedAtUtc'>,
): CheckpointState {
  return {
    sessionId,
    savedAtUtc: new Date().toISOString(),
    ...fields,
  };
}
