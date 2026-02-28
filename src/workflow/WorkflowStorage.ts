// ─── Workflow persistent storage (WF-003) ──────────────────────────────────────
//
// Stores workflow data under .bormagi/workflows/<workflow-id>/:
//   workflow.json     — current workflow snapshot (overwritten on each change)
//   status.json       — lightweight current status (overwritten)
//   artifacts.json    — artifact registry snapshot (overwritten)
//   tasks.jsonl       — append-only task event log
//   handoffs.jsonl    — append-only handoff event log
//   decisions.jsonl   — append-only decision log
//   events.jsonl      — append-only workflow event log
//
// JSON files hold mutable current state.  JSONL files are append-only event logs
// and are never rewritten in full.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Workflow, WorkflowTask, HandoffRequest, Artifact, DecisionLogEntry, WorkflowEvent, WorkflowStage, ReviewRequest, Blocker } from './types';

const WORKFLOWS_DIR = '.bormagi/workflows';

export class WorkflowStorage {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  // ─── Directory helpers ────────────────────────────────────────────────────────

  private workflowDir(workflowId: string): string {
    return path.join(this.workspaceRoot, WORKFLOWS_DIR, workflowId);
  }

  private workflowFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'workflow.json');
  }

  private statusFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'status.json');
  }

  private artifactsFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'artifacts.json');
  }

  private tasksLogPath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'tasks.jsonl');
  }

  private handoffsLogPath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'handoffs.jsonl');
  }

  private decisionsLogPath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'decisions.jsonl');
  }

  private eventsLogPath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'events.jsonl');
  }

  private stagesFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'stages.json');
  }

  private taskSnapshotFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'tasks-snapshot.json');
  }

  private blockersFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'blockers.json');
  }

  private reviewsFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'reviews.json');
  }

  private handoffSnapshotFilePath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'handoffs-snapshot.json');
  }

  // ─── Initialisation ───────────────────────────────────────────────────────────

  async ensureWorkflowDir(workflowId: string): Promise<void> {
    const dir = this.workflowDir(workflowId);
    const uri = vscode.Uri.file(dir);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(uri);
    }
  }

  async listWorkflowIds(): Promise<string[]> {
    const dir = path.join(this.workspaceRoot, WORKFLOWS_DIR);
    const uri = vscode.Uri.file(dir);
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  // ─── Workflow JSON (current state) ────────────────────────────────────────────

  async saveWorkflow(workflow: Workflow): Promise<void> {
    await this.ensureWorkflowDir(workflow.id);
    await this.writeJson(this.workflowFilePath(workflow.id), workflow);
    await this.writeJson(this.statusFilePath(workflow.id), {
      id: workflow.id,
      status: workflow.status,
      currentStageId: workflow.currentStageId,
      activeTaskId: workflow.activeTaskId,
      updatedAt: workflow.updatedAt,
    });
  }

  async loadWorkflow(workflowId: string): Promise<Workflow | null> {
    return this.readJson<Workflow>(this.workflowFilePath(workflowId));
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    const ids = await this.listWorkflowIds();
    const results: Workflow[] = [];
    for (const id of ids) {
      const wf = await this.loadWorkflow(id);
      if (wf) {
        results.push(wf);
      }
    }
    return results;
  }

  // ─── Stages ───────────────────────────────────────────────────────────────────

  async saveStages(workflowId: string, stages: WorkflowStage[]): Promise<void> {
    await this.ensureWorkflowDir(workflowId);
    await this.writeJson(this.stagesFilePath(workflowId), stages);
  }

  async loadStages(workflowId: string): Promise<WorkflowStage[]> {
    const data = await this.readJson<WorkflowStage[]>(this.stagesFilePath(workflowId));
    return data ?? [];
  }

  // ─── Artifacts JSON (current registry state) ──────────────────────────────────

  async saveArtifacts(workflowId: string, artifacts: Artifact[]): Promise<void> {
    await this.ensureWorkflowDir(workflowId);
    await this.writeJson(this.artifactsFilePath(workflowId), artifacts);
  }

  async loadArtifacts(workflowId: string): Promise<Artifact[]> {
    const data = await this.readJson<Artifact[]>(this.artifactsFilePath(workflowId));
    return data ?? [];
  }

  // ─── JSONL append-only logs ───────────────────────────────────────────────────

  async appendTaskEntry(workflowId: string, task: WorkflowTask): Promise<void> {
    this.appendJsonl(this.tasksLogPath(workflowId), { ts: new Date().toISOString(), ...task });
  }

  async appendHandoffEntry(workflowId: string, handoff: HandoffRequest): Promise<void> {
    this.appendJsonl(this.handoffsLogPath(workflowId), { ts: new Date().toISOString(), ...handoff });
  }

  async appendDecisionEntry(workflowId: string, decision: DecisionLogEntry): Promise<void> {
    this.appendJsonl(this.decisionsLogPath(workflowId), { ts: new Date().toISOString(), ...decision });
  }

  async appendEvent(workflowId: string, event: WorkflowEvent): Promise<void> {
    this.appendJsonl(this.eventsLogPath(workflowId), event);
  }

  async loadDecisions(workflowId: string): Promise<DecisionLogEntry[]> {
    return this.readJsonl<DecisionLogEntry>(this.decisionsLogPath(workflowId));
  }

  async loadHandoffs(workflowId: string): Promise<HandoffRequest[]> {
    return this.readJsonl<HandoffRequest>(this.handoffsLogPath(workflowId));
  }

  async loadEvents(workflowId: string): Promise<WorkflowEvent[]> {
    return this.readJsonl<WorkflowEvent>(this.eventsLogPath(workflowId));
  }

  // ─── Task snapshot (mutable current state, distinct from tasks.jsonl log) ─────

  async saveTasks(workflowId: string, tasks: WorkflowTask[]): Promise<void> {
    await this.ensureWorkflowDir(workflowId);
    await this.writeJson(this.taskSnapshotFilePath(workflowId), tasks);
  }

  async loadTasks(workflowId: string): Promise<WorkflowTask[]> {
    const data = await this.readJson<WorkflowTask[]>(this.taskSnapshotFilePath(workflowId));
    return data ?? [];
  }

  // ─── Blockers snapshot ────────────────────────────────────────────────────────

  async saveBlockers(workflowId: string, blockers: Blocker[]): Promise<void> {
    await this.ensureWorkflowDir(workflowId);
    await this.writeJson(this.blockersFilePath(workflowId), blockers);
  }

  async loadBlockers(workflowId: string): Promise<Blocker[]> {
    const data = await this.readJson<Blocker[]>(this.blockersFilePath(workflowId));
    return data ?? [];
  }

  // ─── Reviews snapshot ─────────────────────────────────────────────────────────

  async saveReviews(workflowId: string, reviews: ReviewRequest[]): Promise<void> {
    await this.ensureWorkflowDir(workflowId);
    await this.writeJson(this.reviewsFilePath(workflowId), reviews);
  }

  async loadReviews(workflowId: string): Promise<ReviewRequest[]> {
    const data = await this.readJson<ReviewRequest[]>(this.reviewsFilePath(workflowId));
    return data ?? [];
  }

  // ─── Handoff snapshot (mutable approval state; distinct from handoffs.jsonl) ──

  async saveHandoffSnapshots(workflowId: string, handoffs: HandoffRequest[]): Promise<void> {
    await this.ensureWorkflowDir(workflowId);
    await this.writeJson(this.handoffSnapshotFilePath(workflowId), handoffs);
  }

  async loadHandoffSnapshots(workflowId: string): Promise<HandoffRequest[]> {
    const data = await this.readJson<HandoffRequest[]>(this.handoffSnapshotFilePath(workflowId));
    return data ?? [];
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return JSON.parse(Buffer.from(raw).toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Append a single JSON line to a .jsonl file without reading/rewriting the file. */
  private appendJsonl(filePath: string, record: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  }

  /** Read all lines from a .jsonl file, skipping any corrupt lines. */
  private async readJsonl<T>(filePath: string): Promise<T[]> {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const lines = Buffer.from(raw).toString('utf8').split('\n').filter(l => l.trim().length > 0);
      const results: T[] = [];
      for (const line of lines) {
        try {
          results.push(JSON.parse(line) as T);
        } catch {
          // Skip corrupt lines — do not throw; partial recovery is preferable to total failure.
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
