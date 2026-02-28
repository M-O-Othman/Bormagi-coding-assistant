// ─── Decision log (WF-304) ──────────────────────────────────────────────────────
//
// Records and queries architectural and implementation decisions made during a
// workflow. All entries are append-only; decisions may never be edited or deleted.
//
// A decision log entry captures:
//   - The title and rationale of the decision
//   - Alternatives that were considered (and why they were rejected)
//   - The expected impact on the workflow or system
//   - Links to related artifacts and tasks for full traceability
//
// Decisions are persisted via `WorkflowStorage.appendDecisionEntry()` to the
// decisions.jsonl append-only log, and surfaced to downstream agents through
// `WorkflowContextBuilder` so every delegated agent has full decision context
// without relying on raw chat history.

import { randomUUID as uuidv4 } from 'crypto';
import type { DecisionLogEntry } from './types';
import type { WorkflowStorage } from './WorkflowStorage';

export class DecisionLog {
  constructor(private readonly storage: WorkflowStorage) {}

  // ─── Recording ────────────────────────────────────────────────────────────────

  /**
   * Record a new decision in the workflow's decision log.
   * Decisions are immutable once written — append only.
   */
  async record(
    workflowId: string,
    params: {
      stageId: string;
      taskId: string;
      ownerAgentId: string;
      title: string;
      rationale: string;
      alternativesConsidered: string[];
      impact: string;
      linkedArtifactIds?: string[];
      linkedTaskIds?: string[];
    }
  ): Promise<DecisionLogEntry> {
    const entry: DecisionLogEntry = {
      id: uuidv4(),
      workflowId,
      stageId: params.stageId,
      taskId: params.taskId,
      ownerAgentId: params.ownerAgentId,
      title: params.title,
      rationale: params.rationale,
      alternativesConsidered: params.alternativesConsidered,
      impact: params.impact,
      linkedArtifactIds: params.linkedArtifactIds ?? [],
      linkedTaskIds: params.linkedTaskIds ?? [],
      createdAt: new Date().toISOString(),
    };
    await this.storage.appendDecisionEntry(workflowId, entry);
    return entry;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────────

  /** All decisions for a workflow in chronological order. */
  async getByWorkflow(workflowId: string): Promise<DecisionLogEntry[]> {
    return this.storage.loadDecisions(workflowId);
  }

  /** Decisions associated with a specific stage. */
  async getByStage(workflowId: string, stageId: string): Promise<DecisionLogEntry[]> {
    const all = await this.storage.loadDecisions(workflowId);
    return all.filter(d => d.stageId === stageId);
  }

  /** Decisions associated with a specific task. */
  async getByTask(workflowId: string, taskId: string): Promise<DecisionLogEntry[]> {
    const all = await this.storage.loadDecisions(workflowId);
    return all.filter(d => d.taskId === taskId);
  }

  /**
   * Full-text search across titles, rationale, impact, and alternatives.
   * Case-insensitive substring match.
   */
  async search(workflowId: string, query: string): Promise<DecisionLogEntry[]> {
    const all = await this.storage.loadDecisions(workflowId);
    const q = query.toLowerCase();
    return all.filter(
      d =>
        d.title.toLowerCase().includes(q) ||
        d.rationale.toLowerCase().includes(q) ||
        d.impact.toLowerCase().includes(q) ||
        d.alternativesConsidered.some(a => a.toLowerCase().includes(q))
    );
  }

  /** Decisions that reference a specific artifact. */
  async getByArtifact(workflowId: string, artifactId: string): Promise<DecisionLogEntry[]> {
    const all = await this.storage.loadDecisions(workflowId);
    return all.filter(d => d.linkedArtifactIds.includes(artifactId));
  }

  /** Most recent N decisions for a workflow (useful for context injection summaries). */
  async getRecent(workflowId: string, n: number): Promise<DecisionLogEntry[]> {
    const all = await this.storage.loadDecisions(workflowId);
    return all.slice(-n);
  }
}
