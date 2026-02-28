// ─── Review manager (WF-203) ────────────────────────────────────────────────────
//
// Manages the request-review flow: a lighter-weight alternative to a full handoff.
// The reviewer does NOT take ownership of the task. Instead, the reviewer produces
// one of three outcomes:
//   - approved             — work is accepted as-is
//   - approved_with_comments — accepted but with notes for the original owner to act on
//   - rejected             — work is returned to the original owner with a rejection reason
//
// Reviews are stored as mutable JSON snapshots (reviews.json) for fast queries.
// Review history is accessible via the workflow event log.

import { randomUUID as uuidv4 } from 'crypto';
import { ReviewStatus } from './enums';
import type { ReviewRequest } from './types';
import type { WorkflowStorage } from './WorkflowStorage';

export type ReviewOutcome = 'approved' | 'approved_with_comments' | 'rejected';

export class ReviewManager {
  constructor(private readonly storage: WorkflowStorage) {}

  // ─── Request ──────────────────────────────────────────────────────────────────

  /**
   * Open a new review request.
   * The review starts in Pending state and is assigned to the `reviewerAgentId`.
   */
  async requestReview(
    workflowId: string,
    params: {
      taskId: string;
      requestingAgentId: string;
      reviewerAgentId: string;
      itemUnderReview: string;
      reviewScope: string;
      reviewCriteria: string[];
      isBlocking: boolean;
    }
  ): Promise<ReviewRequest> {
    const now = new Date().toISOString();
    const review: ReviewRequest = {
      id: uuidv4(),
      workflowId,
      taskId: params.taskId,
      requestingAgentId: params.requestingAgentId,
      reviewerAgentId: params.reviewerAgentId,
      itemUnderReview: params.itemUnderReview,
      reviewScope: params.reviewScope,
      reviewCriteria: params.reviewCriteria,
      isBlocking: params.isBlocking,
      status: ReviewStatus.Pending,
      outcome: null,
      comments: null,
      rejectionReason: null,
      createdAt: now,
      completedAt: null,
    };
    await this.saveReview(workflowId, review);
    return review;
  }

  // ─── Completion ───────────────────────────────────────────────────────────────

  /**
   * Complete a review with an outcome.
   * If outcome is 'rejected', a `rejectionReason` should be supplied.
   */
  async completeReview(
    workflowId: string,
    reviewId: string,
    outcome: ReviewOutcome,
    comments?: string,
    rejectionReason?: string
  ): Promise<ReviewRequest> {
    const review = await this.requireReview(workflowId, reviewId);

    if (review.status !== ReviewStatus.Pending) {
      throw new Error(
        `Review "${reviewId}" cannot be completed: current status is "${review.status}", expected "pending".`
      );
    }

    const updated: ReviewRequest = {
      ...review,
      status: ReviewStatus.Completed,
      outcome,
      comments: comments ?? null,
      rejectionReason: outcome === 'rejected' ? (rejectionReason ?? null) : null,
      completedAt: new Date().toISOString(),
    };
    await this.saveReview(workflowId, updated);
    return updated;
  }

  /**
   * Cancel a pending review (e.g. the work was superseded before review completed).
   */
  async cancelReview(workflowId: string, reviewId: string): Promise<ReviewRequest> {
    const review = await this.requireReview(workflowId, reviewId);

    if (review.status !== ReviewStatus.Pending) {
      throw new Error(
        `Review "${reviewId}" cannot be cancelled: current status is "${review.status}".`
      );
    }

    const updated: ReviewRequest = {
      ...review,
      status: ReviewStatus.Cancelled,
      completedAt: new Date().toISOString(),
    };
    await this.saveReview(workflowId, updated);
    return updated;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────────

  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null> {
    const all = await this.storage.loadReviews(workflowId);
    return all.find(r => r.id === reviewId) ?? null;
  }

  async listByTask(workflowId: string, taskId: string): Promise<ReviewRequest[]> {
    const all = await this.storage.loadReviews(workflowId);
    return all.filter(r => r.taskId === taskId);
  }

  async listPending(workflowId: string): Promise<ReviewRequest[]> {
    const all = await this.storage.loadReviews(workflowId);
    return all.filter(r => r.status === ReviewStatus.Pending);
  }

  /** Reviews requested by a specific agent. */
  async listByRequester(workflowId: string, agentId: string): Promise<ReviewRequest[]> {
    const all = await this.storage.loadReviews(workflowId);
    return all.filter(r => r.requestingAgentId === agentId);
  }

  /** Reviews assigned to a specific reviewer. */
  async listByReviewer(workflowId: string, reviewerAgentId: string): Promise<ReviewRequest[]> {
    const all = await this.storage.loadReviews(workflowId);
    return all.filter(r => r.reviewerAgentId === reviewerAgentId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async requireReview(workflowId: string, reviewId: string): Promise<ReviewRequest> {
    const r = await this.getReview(workflowId, reviewId);
    if (!r) {
      throw new Error(`Review "${reviewId}" not found in workflow "${workflowId}".`);
    }
    return r;
  }

  /** Upsert a review into the snapshot store. */
  private async saveReview(workflowId: string, review: ReviewRequest): Promise<void> {
    const all = await this.storage.loadReviews(workflowId);
    const index = all.findIndex(r => r.id === review.id);
    if (index === -1) {
      all.push(review);
    } else {
      all[index] = review;
    }
    await this.storage.saveReviews(workflowId, all);
  }
}
