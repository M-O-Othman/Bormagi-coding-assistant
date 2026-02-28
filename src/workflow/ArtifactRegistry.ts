// ─── Artifact registry (WF-004) ────────────────────────────────────────────────
//
// Tracks all artifacts produced within a workflow.  Each artifact has a path,
// type, producing agent/task/stage, version, and an approval lifecycle.
//
// The registry is backed by WorkflowStorage (artifacts.json).  All mutations
// go through this class; callers never write artifacts.json directly.

import { randomUUID as uuidv4 } from 'crypto';
import { ArtifactApprovalStatus } from './enums';
import type { Artifact, ValidationResult } from './types';
import type { WorkflowStorage } from './WorkflowStorage';

export class ArtifactRegistry {
  constructor(private readonly storage: WorkflowStorage) {}

  // ─── Registration ─────────────────────────────────────────────────────────────

  /**
   * Register a new artifact in the registry.
   * Throws if an artifact with the same path already exists at an approved or
   * submitted state — callers must use `supersede()` to create a new version.
   */
  async register(
    workflowId: string,
    params: {
      stageId: string;
      taskId: string;
      producingAgentId: string;
      name: string;
      description: string;
      type: string;
      path: string;
    }
  ): Promise<Artifact> {
    const artifacts = await this.storage.loadArtifacts(workflowId);

    // Reject duplicate registration of an active (non-superseded) artifact.
    const existing = artifacts.find(
      a => a.path === params.path && a.approvalStatus !== ArtifactApprovalStatus.Superseded
    );
    if (existing) {
      throw new Error(
        `Artifact at path "${params.path}" already exists in the registry (id: ${existing.id}, status: ${existing.approvalStatus}). ` +
        `Use supersede() to create a new version.`
      );
    }

    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: uuidv4(),
      workflowId,
      stageId: params.stageId,
      taskId: params.taskId,
      producingAgentId: params.producingAgentId,
      name: params.name,
      description: params.description,
      type: params.type,
      path: params.path,
      version: 1,
      approvalStatus: ArtifactApprovalStatus.Draft,
      supersededById: null,
      submittedBy: null,
      approvedBy: null,
      rejectedBy: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };

    artifacts.push(artifact);
    await this.storage.saveArtifacts(workflowId, artifacts);
    return artifact;
  }

  // ─── Approval lifecycle ───────────────────────────────────────────────────────

  async submit(workflowId: string, artifactId: string, submittedBy: string): Promise<Artifact> {
    return this.updateArtifact(workflowId, artifactId, a => {
      if (a.approvalStatus !== ArtifactApprovalStatus.Draft) {
        throw new Error(`Cannot submit artifact "${artifactId}": status is "${a.approvalStatus}", expected "draft".`);
      }
      a.approvalStatus = ArtifactApprovalStatus.Submitted;
      a.submittedBy = submittedBy;
      a.updatedAt = new Date().toISOString();
    });
  }

  async approve(workflowId: string, artifactId: string, approvedBy: string): Promise<Artifact> {
    return this.updateArtifact(workflowId, artifactId, a => {
      if (a.approvalStatus !== ArtifactApprovalStatus.Submitted) {
        throw new Error(`Cannot approve artifact "${artifactId}": status is "${a.approvalStatus}", expected "submitted".`);
      }
      a.approvalStatus = ArtifactApprovalStatus.Approved;
      a.approvedBy = approvedBy;
      a.updatedAt = new Date().toISOString();
    });
  }

  async reject(workflowId: string, artifactId: string, rejectedBy: string, reason: string): Promise<Artifact> {
    return this.updateArtifact(workflowId, artifactId, a => {
      if (a.approvalStatus !== ArtifactApprovalStatus.Submitted) {
        throw new Error(`Cannot reject artifact "${artifactId}": status is "${a.approvalStatus}", expected "submitted".`);
      }
      a.approvalStatus = ArtifactApprovalStatus.Rejected;
      a.rejectedBy = rejectedBy;
      a.rejectionReason = reason;
      a.updatedAt = new Date().toISOString();
    });
  }

  /**
   * Create a new version of an existing artifact, marking the old one as
   * superseded. Returns the newly created artifact.
   */
  async supersede(
    workflowId: string,
    artifactId: string,
    params: {
      stageId: string;
      taskId: string;
      producingAgentId: string;
      description: string;
    }
  ): Promise<Artifact> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    const oldIndex = artifacts.findIndex(a => a.id === artifactId);
    if (oldIndex === -1) {
      throw new Error(`Artifact "${artifactId}" not found in workflow "${workflowId}".`);
    }
    const old = artifacts[oldIndex];

    const now = new Date().toISOString();
    const newArtifact: Artifact = {
      id: uuidv4(),
      workflowId,
      stageId: params.stageId,
      taskId: params.taskId,
      producingAgentId: params.producingAgentId,
      name: old.name,
      description: params.description,
      type: old.type,
      path: old.path,
      version: old.version + 1,
      approvalStatus: ArtifactApprovalStatus.Draft,
      supersededById: null,
      submittedBy: null,
      approvedBy: null,
      rejectedBy: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };

    // Mark the old artifact as superseded.
    artifacts[oldIndex] = {
      ...old,
      approvalStatus: ArtifactApprovalStatus.Superseded,
      supersededById: newArtifact.id,
      updatedAt: now,
    };
    artifacts.push(newArtifact);
    await this.storage.saveArtifacts(workflowId, artifacts);
    return newArtifact;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────────

  async getById(workflowId: string, artifactId: string): Promise<Artifact | null> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    return artifacts.find(a => a.id === artifactId) ?? null;
  }

  async getByStage(workflowId: string, stageId: string): Promise<Artifact[]> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    return artifacts.filter(a => a.stageId === stageId);
  }

  async getByTask(workflowId: string, taskId: string): Promise<Artifact[]> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    return artifacts.filter(a => a.taskId === taskId);
  }

  async getByType(workflowId: string, type: string): Promise<Artifact[]> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    return artifacts.filter(a => a.type === type);
  }

  async getByApprovalStatus(workflowId: string, status: Artifact['approvalStatus']): Promise<Artifact[]> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    return artifacts.filter(a => a.approvalStatus === status);
  }

  /** Returns the latest non-superseded version of an artifact at a given path. */
  async getLatestByPath(workflowId: string, filePath: string): Promise<Artifact | null> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    const candidates = artifacts
      .filter(a => a.path === filePath && a.approvalStatus !== ArtifactApprovalStatus.Superseded)
      .sort((a, b) => b.version - a.version);
    return candidates[0] ?? null;
  }

  async getAll(workflowId: string): Promise<Artifact[]> {
    return this.storage.loadArtifacts(workflowId);
  }

  /** Validate that a set of artifact IDs all exist and are approved. */
  async validateAllApproved(workflowId: string, artifactIds: string[]): Promise<ValidationResult> {
    const errors: Array<{ code: string; message: string }> = [];
    for (const id of artifactIds) {
      const artifact = await this.getById(workflowId, id);
      if (!artifact) {
        errors.push({ code: 'ARTIFACT_NOT_FOUND', message: `Required artifact "${id}" does not exist.` });
      } else if (artifact.approvalStatus !== ArtifactApprovalStatus.Approved) {
        errors.push({
          code: 'ARTIFACT_NOT_APPROVED',
          message: `Required artifact "${artifact.name}" (${id}) has status "${artifact.approvalStatus}", but "approved" is required.`,
        });
      }
    }
    return { isValid: errors.length === 0, errors };
  }

  // ─── WF-303: Stage-gate integration ──────────────────────────────────────────

  /**
   * Build a stage completion report showing which required output types have been
   * produced (and their approval status) versus which are still missing.
   * Used by StageGate and the workflow UI panel.
   */
  async getStageCompletionReport(
    workflowId: string,
    stageId: string,
    requiredOutputTypes: string[]
  ): Promise<{
    produced: { type: string; artifactName: string; status: string }[];
    missing: string[];
    isComplete: boolean;
  }> {
    const stageArtifacts = await this.getByStage(workflowId, stageId);
    const produced: { type: string; artifactName: string; status: string }[] = [];
    const missing: string[] = [];

    for (const requiredType of requiredOutputTypes) {
      const artifact = stageArtifacts.find(a => a.type === requiredType);
      if (artifact) {
        produced.push({ type: requiredType, artifactName: artifact.name, status: artifact.approvalStatus });
      } else {
        missing.push(requiredType);
      }
    }

    return { produced, missing, isComplete: missing.length === 0 };
  }

  /**
   * Return a map of `type → Artifact[]` for all approved artifacts matching the given types.
   * Used by the stage gate to validate multi-type prerequisites in a single call.
   */
  async getApprovedByType(
    workflowId: string,
    types: string[]
  ): Promise<Map<string, Artifact[]>> {
    const all = await this.storage.loadArtifacts(workflowId);
    const result = new Map<string, Artifact[]>();
    for (const type of types) {
      result.set(
        type,
        all.filter(a => a.type === type && a.approvalStatus === ArtifactApprovalStatus.Approved)
      );
    }
    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async updateArtifact(
    workflowId: string,
    artifactId: string,
    mutate: (artifact: Artifact) => void
  ): Promise<Artifact> {
    const artifacts = await this.storage.loadArtifacts(workflowId);
    const index = artifacts.findIndex(a => a.id === artifactId);
    if (index === -1) {
      throw new Error(`Artifact "${artifactId}" not found in workflow "${workflowId}".`);
    }
    mutate(artifacts[index]);
    await this.storage.saveArtifacts(workflowId, artifacts);
    return artifacts[index];
  }
}

// Re-export ValidationResult for callers that only import from this module.
export type { ValidationResult } from './types';
