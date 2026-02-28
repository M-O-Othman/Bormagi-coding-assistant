// ─── Execution lock (WF-102) ────────────────────────────────────────────────────
//
// Ensures only one agent task may run within a workflow at a time.
// Prevents concurrent task execution, simultaneous parent + child execution,
// and simultaneous review + implementation on the same task.
//
// The lock is backed by an in-memory map (fast) plus a lock file on disk
// (.bormagi/workflows/<id>/execution.lock) for persistence across extension
// state refreshes where feasible.

import * as fs from 'fs';
import * as path from 'path';

interface LockEntry {
  workflowId: string;
  taskId: string;
  agentId: string;
  acquiredAt: string;  // ISO 8601
}

export class ExecutionLock {
  /** In-memory lock state. Key = workflowId. */
  private readonly locks = new Map<string, LockEntry>();
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  // ─── Lock operations ──────────────────────────────────────────────────────────

  /**
   * Acquire the execution lock for a workflow.
   * Throws if the workflow is already locked (another task is running).
   */
  acquire(workflowId: string, taskId: string, agentId: string): void {
    const existing = this.locks.get(workflowId);
    if (existing) {
      throw new Error(
        `Execution lock for workflow "${workflowId}" is already held by ` +
        `task "${existing.taskId}" (agent: ${existing.agentId}, acquired: ${existing.acquiredAt}). ` +
        `Only one agent may execute within a workflow at a time.`
      );
    }

    const entry: LockEntry = {
      workflowId,
      taskId,
      agentId,
      acquiredAt: new Date().toISOString(),
    };

    this.locks.set(workflowId, entry);
    this.persistLock(workflowId, entry);
  }

  /**
   * Release the execution lock for a workflow.
   * Safe to call even if the lock is not currently held (idempotent).
   */
  release(workflowId: string): void {
    this.locks.delete(workflowId);
    this.clearPersistedLock(workflowId);
  }

  /**
   * Check whether the given workflow currently holds an execution lock.
   */
  isLocked(workflowId: string): boolean {
    return this.locks.has(workflowId);
  }

  /**
   * Return the current lock holder for a workflow, or null if unlocked.
   */
  getLockHolder(workflowId: string): LockEntry | null {
    return this.locks.get(workflowId) ?? null;
  }

  /**
   * Force-release a lock regardless of which task holds it.
   * Should only be called on cancellation or during recovery.
   * Always logs the forced release to the console for audit visibility.
   */
  forceRelease(workflowId: string, reason: string): void {
    const existing = this.locks.get(workflowId);
    if (existing) {
      console.warn(
        `[ExecutionLock] Force-releasing lock for workflow "${workflowId}" ` +
        `(was held by task "${existing.taskId}", agent: ${existing.agentId}). Reason: ${reason}`
      );
    }
    this.release(workflowId);
  }

  // ─── Recovery ─────────────────────────────────────────────────────────────────

  /**
   * Attempt to restore lock state from persisted .lock files.
   * Called during extension startup to recover from an interrupted session.
   * Lock files that are older than `staleLimitMs` are considered orphaned
   * and discarded rather than restored.
   */
  recoverFromDisk(workflowIds: string[], staleLimitMs = 4 * 60 * 60 * 1000): void {
    for (const workflowId of workflowIds) {
      const lockPath = this.lockFilePath(workflowId);
      try {
        if (!fs.existsSync(lockPath)) {
          continue;
        }
        const raw = fs.readFileSync(lockPath, 'utf8');
        const entry = JSON.parse(raw) as LockEntry;

        const ageMs = Date.now() - new Date(entry.acquiredAt).getTime();
        if (ageMs > staleLimitMs) {
          console.warn(
            `[ExecutionLock] Discarding stale lock for workflow "${workflowId}" ` +
            `(age: ${Math.round(ageMs / 60000)} min, task: ${entry.taskId}).`
          );
          this.clearPersistedLock(workflowId);
          continue;
        }

        this.locks.set(workflowId, entry);
      } catch {
        // Corrupt lock file — discard.
        this.clearPersistedLock(workflowId);
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private lockFilePath(workflowId: string): string {
    return path.join(this.workspaceRoot, '.bormagi', 'workflows', workflowId, 'execution.lock');
  }

  private persistLock(workflowId: string, entry: LockEntry): void {
    try {
      const lockPath = this.lockFilePath(workflowId);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify(entry, null, 2), 'utf8');
    } catch {
      // Non-fatal: in-memory lock is still effective.  Persistence is best-effort.
    }
  }

  private clearPersistedLock(workflowId: string): void {
    try {
      const lockPath = this.lockFilePath(workflowId);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Non-fatal.
    }
  }
}
