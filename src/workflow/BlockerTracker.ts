// ─── Blocker tracker (WF-305) ───────────────────────────────────────────────────
//
// Manages the complete lifecycle of Blocker entities.
// A blocker represents an obstacle that prevents a task or stage from progressing.
//
// Blocker states (reflected in the `isResolved` and `isEscalated` flags):
//   Active      — raised, not yet resolved
//   Escalated   — flagged for human owner attention; still unresolved
//   Resolved    — obstacle removed; resolution notes and resolver recorded
//
// Blockers that carry BlockerSeverity.Critical will surface as high-priority
// items in the workflow UI and in the open-questions file.
//
// Storage: blockers.json mutable snapshot (current state) via WorkflowStorage.
// The workflow event log (events.jsonl) provides the full audit trail for every
// blocker mutation via WorkflowEngine.emitEvent().

import { randomUUID as uuidv4 } from 'crypto';
import { BlockerSeverity } from './enums';
import type { Blocker } from './types';
import type { WorkflowStorage } from './WorkflowStorage';

export { BlockerSeverity };  // Re-export for caller convenience

export class BlockerTracker {
  constructor(private readonly storage: WorkflowStorage) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Raise a new blocker.
   * The blocker starts in an unresolved, non-escalated state.
   */
  async raise(
    workflowId: string,
    params: {
      stageId: string;
      taskId: string;
      raisedByAgentId: string;
      reason: string;
      severity: BlockerSeverity;
      suggestedRoute: string;
    }
  ): Promise<Blocker> {
    const now = new Date().toISOString();
    const blocker: Blocker = {
      id: uuidv4(),
      workflowId,
      stageId: params.stageId,
      taskId: params.taskId,
      raisedByAgentId: params.raisedByAgentId,
      reason: params.reason,
      severity: params.severity,
      suggestedRoute: params.suggestedRoute,
      resolutionNotes: null,
      resolvedBy: null,
      isResolved: false,
      isEscalated: false,
      createdAt: now,
      resolvedAt: null,
    };

    const all = await this.storage.loadBlockers(workflowId);
    all.push(blocker);
    await this.storage.saveBlockers(workflowId, all);
    return blocker;
  }

  /**
   * Mark a blocker as resolved.
   * Records who resolved it and the resolution notes explaining how the obstacle
   * was removed. Throws if the blocker is already resolved.
   */
  async resolve(
    workflowId: string,
    blockerId: string,
    resolutionNotes: string,
    resolvedBy: string
  ): Promise<Blocker> {
    return this.mutateBlocker(workflowId, blockerId, b => {
      if (b.isResolved) {
        throw new Error(
          `Blocker "${blockerId}" is already resolved (resolved by "${b.resolvedBy}" at ${b.resolvedAt}).`
        );
      }
      b.isResolved = true;
      b.resolutionNotes = resolutionNotes;
      b.resolvedBy = resolvedBy;
      b.resolvedAt = new Date().toISOString();
    });
  }

  /**
   * Escalate a blocker to the human owner for decision.
   * Escalation does NOT resolve the blocker — it flags it for human attention.
   * An already-escalated or resolved blocker cannot be escalated again.
   */
  async escalate(
    workflowId: string,
    blockerId: string,
    escalatedBy: string
  ): Promise<Blocker> {
    return this.mutateBlocker(workflowId, blockerId, b => {
      if (b.isResolved) {
        throw new Error(
          `Blocker "${blockerId}" is already resolved and cannot be escalated.`
        );
      }
      if (b.isEscalated) {
        throw new Error(`Blocker "${blockerId}" is already escalated.`);
      }
      b.isEscalated = true;
      // Append escalation note to resolution notes for traceability
      const escalationNote = `Escalated by "${escalatedBy}" at ${new Date().toISOString()}.`;
      b.resolutionNotes = b.resolutionNotes
        ? `${b.resolutionNotes}\n${escalationNote}`
        : escalationNote;
    });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────────

  async getById(workflowId: string, blockerId: string): Promise<Blocker | null> {
    const all = await this.storage.loadBlockers(workflowId);
    return all.find(b => b.id === blockerId) ?? null;
  }

  /** All unresolved blockers for a workflow. */
  async getActive(workflowId: string): Promise<Blocker[]> {
    const all = await this.storage.loadBlockers(workflowId);
    return all.filter(b => !b.isResolved);
  }

  /** Unresolved blockers for a specific stage. */
  async getActiveByStage(workflowId: string, stageId: string): Promise<Blocker[]> {
    const all = await this.storage.loadBlockers(workflowId);
    return all.filter(b => b.stageId === stageId && !b.isResolved);
  }

  /** All blockers (resolved and unresolved) for a specific task. */
  async getByTask(workflowId: string, taskId: string): Promise<Blocker[]> {
    const all = await this.storage.loadBlockers(workflowId);
    return all.filter(b => b.taskId === taskId);
  }

  /** Unresolved blockers that have been escalated to the human owner. */
  async getEscalated(workflowId: string): Promise<Blocker[]> {
    const all = await this.storage.loadBlockers(workflowId);
    return all.filter(b => b.isEscalated && !b.isResolved);
  }

  /** Critical unresolved blockers (severity = critical). */
  async getCritical(workflowId: string): Promise<Blocker[]> {
    const all = await this.storage.loadBlockers(workflowId);
    return all.filter(b => b.severity === BlockerSeverity.Critical && !b.isResolved);
  }

  /** All blockers for a workflow in chronological order. */
  async getAll(workflowId: string): Promise<Blocker[]> {
    return this.storage.loadBlockers(workflowId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async mutateBlocker(
    workflowId: string,
    blockerId: string,
    mutate: (blocker: Blocker) => void
  ): Promise<Blocker> {
    const all = await this.storage.loadBlockers(workflowId);
    const index = all.findIndex(b => b.id === blockerId);
    if (index === -1) {
      throw new Error(`Blocker "${blockerId}" not found in workflow "${workflowId}".`);
    }
    mutate(all[index]);
    await this.storage.saveBlockers(workflowId, all);
    return all[index];
  }
}
