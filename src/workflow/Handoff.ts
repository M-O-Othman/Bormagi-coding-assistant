// ─── Handoff manager (WF-201) ───────────────────────────────────────────────────
//
// Manages the lifecycle of HandoffRequest objects.
// A handoff is the formal mechanism by which one agent delegates a task to another.
// No agent-to-agent delegation may occur without a valid, persisted HandoffRequest.
//
// Handoffs have two storage layers:
//   1. handoffs.jsonl  — append-only event log of every handoff ever created.
//   2. handoffs-snapshot.json — mutable JSON tracking current approval state for
//      O(1) lookup without replaying the log.

import { randomUUID as uuidv4 } from 'crypto';
import type { HandoffRequest } from './types';
import type { WorkflowStorage } from './WorkflowStorage';

/** Fields required to create a new handoff. Derived fields are added automatically. */
export type CreateHandoffParams = Omit<
  HandoffRequest,
  'id' | 'createdAt' | 'isApproved' | 'approvedBy' | 'approvedAt' | 'rejectionReason' | 'humanNote'
>;

export class HandoffManager {
  constructor(private readonly storage: WorkflowStorage) {}

  // ─── Creation ─────────────────────────────────────────────────────────────────

  /**
   * Create and persist a new handoff request.
   * Appends to the event log and updates the mutable snapshot.
   */
  async createHandoff(workflowId: string, params: CreateHandoffParams): Promise<HandoffRequest> {
    const now = new Date().toISOString();
    const handoff: HandoffRequest = {
      ...params,
      id: uuidv4(),
      isApproved: null,
      approvedBy: null,
      approvedAt: null,
      rejectionReason: null,
      humanNote: null,
      createdAt: now,
    };

    // Append to event log (append-only; never rewritten)
    await this.storage.appendHandoffEntry(workflowId, handoff);
    // Update mutable snapshot for fast queries
    await this.updateSnapshot(workflowId, handoff);
    return handoff;
  }

  // ─── Approval lifecycle ───────────────────────────────────────────────────────

  /**
   * Approve a pending handoff.
   * Throws if the handoff has already been approved or rejected.
   */
  async approveHandoff(
    workflowId: string,
    handoffId: string,
    approvedBy: string,
    note?: string
  ): Promise<HandoffRequest> {
    const handoff = await this.requireHandoff(workflowId, handoffId);

    if (handoff.isApproved !== null) {
      throw new Error(
        `Handoff "${handoffId}" has already been ${handoff.isApproved ? 'approved' : 'rejected'}. ` +
        `To retry, create a new handoff request.`
      );
    }

    const updated: HandoffRequest = {
      ...handoff,
      isApproved: true,
      approvedBy,
      approvedAt: new Date().toISOString(),
      humanNote: note ?? null,
    };
    await this.updateSnapshot(workflowId, updated);
    return updated;
  }

  /**
   * Reject a pending handoff.
   * Records the rejecting party and a mandatory rejection reason.
   */
  async rejectHandoff(
    workflowId: string,
    handoffId: string,
    rejectedBy: string,
    reason: string
  ): Promise<HandoffRequest> {
    const handoff = await this.requireHandoff(workflowId, handoffId);

    if (handoff.isApproved !== null) {
      throw new Error(
        `Handoff "${handoffId}" has already been ${handoff.isApproved ? 'approved' : 'rejected'}.`
      );
    }

    const updated: HandoffRequest = {
      ...handoff,
      isApproved: false,
      approvedBy: rejectedBy,
      approvedAt: new Date().toISOString(),
      rejectionReason: reason,
    };
    await this.updateSnapshot(workflowId, updated);
    return updated;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────────

  async getHandoff(workflowId: string, handoffId: string): Promise<HandoffRequest | null> {
    const all = await this.storage.loadHandoffSnapshots(workflowId);
    return all.find(h => h.id === handoffId) ?? null;
  }

  async listHandoffs(workflowId: string): Promise<HandoffRequest[]> {
    return this.storage.loadHandoffSnapshots(workflowId);
  }

  /** Handoffs awaiting human or system approval (isApproved === null). */
  async listPendingHandoffs(workflowId: string): Promise<HandoffRequest[]> {
    const all = await this.listHandoffs(workflowId);
    return all.filter(h => h.isApproved === null);
  }

  /** Handoffs from a given agent. */
  async listByFromAgent(workflowId: string, fromAgentId: string): Promise<HandoffRequest[]> {
    const all = await this.listHandoffs(workflowId);
    return all.filter(h => h.fromAgentId === fromAgentId);
  }

  /** Handoffs directed to a given agent. */
  async listByToAgent(workflowId: string, toAgentId: string): Promise<HandoffRequest[]> {
    const all = await this.listHandoffs(workflowId);
    return all.filter(h => h.toAgentId === toAgentId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async requireHandoff(workflowId: string, handoffId: string): Promise<HandoffRequest> {
    const h = await this.getHandoff(workflowId, handoffId);
    if (!h) {
      throw new Error(`Handoff "${handoffId}" not found in workflow "${workflowId}".`);
    }
    return h;
  }

  /** Upsert a handoff into the mutable snapshot. */
  private async updateSnapshot(workflowId: string, handoff: HandoffRequest): Promise<void> {
    const all = await this.storage.loadHandoffSnapshots(workflowId);
    const index = all.findIndex(h => h.id === handoff.id);
    if (index === -1) {
      all.push(handoff);
    } else {
      all[index] = handoff;
    }
    await this.storage.saveHandoffSnapshots(workflowId, all);
  }
}
