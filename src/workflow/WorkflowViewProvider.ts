// ─── Workflow board WebviewView provider (WF-501) ──────────────────────────────
//
// Provides the VS Code WebviewView panel that hosts workflow-board.html.
// Handles bidirectional messaging between the extension host and the webview.
//
// Webview → extension messages (from webview JS):
//   get_board_data          — refresh all column data for the Kanban board
//   get_workflow_detail     — load full detail for one workflow
//   get_task_detail         — load full detail for one task
//   get_artifacts           — load artifact registry with optional filters
//   get_events              — load event timeline (optionally filtered)
//   approve_handoff         — approve a pending handoff delegation
//   reject_handoff          — reject a pending handoff delegation
//   create_workflow         — create a new workflow from the wizard form
//   open_file               — open a workspace file in the editor
//
// Extension → webview messages:
//   board_data              — full board state
//   workflow_detail         — workflow detail payload
//   task_detail             — task detail payload
//   artifacts               — artifact list payload
//   events                  — event timeline payload
//   handoff_result          — approve/reject outcome
//   create_result           — workflow creation outcome
//   error                   — error message string

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkflowStorage } from './WorkflowStorage';
import { WorkflowEngine } from './WorkflowEngine';
import { ArtifactRegistry } from './ArtifactRegistry';
import { HandoffManager } from './Handoff';
import { WorkflowTemplate } from './WorkflowTemplate';
import { TaskStatus, StageStatus, WorkflowStatus, ReviewStatus } from './enums';
import type { Workflow, WorkflowTask, WorkflowStage } from './types';

export class WorkflowViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'bormagi.workflowBoard';

  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
    private readonly storage: WorkflowStorage,
    private readonly engine: WorkflowEngine,
    private readonly artifactRegistry: ArtifactRegistry
  ) {}

  // ─── VS Code lifecycle ────────────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      await this.handleMessage(msg);
    });
  }

  /** Push updated board data to the webview whenever called. */
  async refresh(): Promise<void> {
    if (!this._view) return;
    const data = await this.buildBoardData();
    this.post({ type: 'board_data', data });
  }

  // ─── Message handling ─────────────────────────────────────────────────────────

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    try {
      switch (msg.type) {
        case 'get_board_data':
          this.post({ type: 'board_data', data: await this.buildBoardData() });
          break;

        case 'get_workflow_detail': {
          const workflowId = msg.workflowId as string;
          const detail = await this.buildWorkflowDetail(workflowId);
          this.post({ type: 'workflow_detail', data: detail });
          break;
        }

        case 'get_task_detail': {
          const { workflowId, taskId } = msg as { workflowId: string; taskId: string };
          const detail = await this.buildTaskDetail(workflowId, taskId);
          this.post({ type: 'task_detail', data: detail });
          break;
        }

        case 'get_artifacts': {
          const workflowId = msg.workflowId as string;
          const stageFilter = msg.stageId as string | undefined;
          const statusFilter = msg.approvalStatus as string | undefined;
          let artifacts = await this.artifactRegistry.getAll(workflowId);
          if (stageFilter) artifacts = artifacts.filter(a => a.stageId === stageFilter);
          if (statusFilter) artifacts = artifacts.filter(a => a.approvalStatus === statusFilter);
          this.post({ type: 'artifacts', data: artifacts });
          break;
        }

        case 'get_events': {
          const workflowId = msg.workflowId as string;
          const eventFilter = msg.eventType as string | undefined;
          let events = await this.storage.loadEvents(workflowId);
          if (eventFilter) events = events.filter(e => e.eventType === eventFilter);
          this.post({ type: 'events', data: events });
          break;
        }

        case 'approve_handoff': {
          const { workflowId, handoffId, approvedBy } = msg as {
            workflowId: string; handoffId: string; approvedBy: string;
          };
          const handoffMgr = new HandoffManager(this.storage);
          const handoff = await handoffMgr.approveHandoff(workflowId, handoffId, approvedBy);
          this.post({ type: 'handoff_result', data: { success: true, handoff } });
          await this.refresh();
          break;
        }

        case 'reject_handoff': {
          const { workflowId, handoffId, rejectedBy, reason } = msg as {
            workflowId: string; handoffId: string; rejectedBy: string; reason: string;
          };
          const handoffMgr = new HandoffManager(this.storage);
          const handoff = await handoffMgr.rejectHandoff(workflowId, handoffId, rejectedBy, reason);
          this.post({ type: 'handoff_result', data: { success: false, handoff } });
          await this.refresh();
          break;
        }

        case 'create_workflow': {
          const { template, title, humanOwner, linkedIssueId } = msg as {
            template: WorkflowTemplate;
            title: string;
            humanOwner: string;
            linkedIssueId?: string;
          };
          const result = await this.engine.createWorkflow({ template, title, humanOwner, linkedIssueId });
          this.post({ type: 'create_result', data: { workflowId: result.workflow.id } });
          await this.refresh();
          break;
        }

        case 'open_file': {
          const relPath = msg.path as string;
          const absPath = path.join(this.workspaceRoot, relPath);
          if (fs.existsSync(absPath)) {
            await vscode.workspace.openTextDocument(absPath).then(doc =>
              vscode.window.showTextDocument(doc)
            );
          }
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    }
  }

  // ─── Data builders ────────────────────────────────────────────────────────────

  /** Build the full Kanban board payload — all workflows with their tasks sorted into columns. */
  private async buildBoardData(): Promise<Record<string, unknown>> {
    const workflowIds = await this.storage.listWorkflowIds();
    const columns: {
      backlog: unknown[];
      active: unknown[];
      waitingReview: unknown[];
      blocked: unknown[];
      done: unknown[];
    } = { backlog: [], active: [], waitingReview: [], blocked: [], done: [] };

    for (const id of workflowIds) {
      const wf = await this.storage.loadWorkflow(id);
      if (!wf) continue;
      const tasks = await this.storage.loadTasks(id);
      const blockers = (await this.storage.loadBlockers(id)).filter(b => !b.isResolved);

      for (const task of tasks) {
        const card = {
          workflowId: id,
          workflowTitle: wf.title,
          taskId: task.id,
          title: task.title,
          stageId: task.stageId,
          ownerAgentId: task.ownerAgentId,
          status: task.status,
          blockerCount: blockers.filter(b => b.taskId === task.id).length,
          createdAt: task.createdAt,
        };

        switch (task.status as TaskStatus) {
          case TaskStatus.Queued:     columns.backlog.push(card); break;
          case TaskStatus.Active:     columns.active.push(card); break;
          case TaskStatus.WaitingReview:
          case TaskStatus.WaitingChild: columns.waitingReview.push(card); break;
          case TaskStatus.Blocked:    columns.blocked.push(card); break;
          case TaskStatus.Completed:
          case TaskStatus.Cancelled:
          case TaskStatus.Failed:     columns.done.push(card); break;
        }
      }
    }

    return columns;
  }

  /** Build the detailed view payload for a single workflow. */
  private async buildWorkflowDetail(workflowId: string): Promise<Record<string, unknown>> {
    const wf = await this.storage.loadWorkflow(workflowId);
    if (!wf) throw new Error(`Workflow "${workflowId}" not found.`);

    const stages = await this.storage.loadStages(workflowId);
    const tasks = await this.storage.loadTasks(workflowId);
    const blockers = await this.storage.loadBlockers(workflowId);
    const reviews = await this.storage.loadReviews(workflowId);
    const artifacts = await this.artifactRegistry.getAll(workflowId);
    const handoffs = await this.storage.loadHandoffSnapshots(workflowId);
    const decisions = await this.storage.loadDecisions(workflowId);

    const stagesWithTasks = stages.map(stage => ({
      ...stage,
      tasks: tasks.filter(t => t.stageId === stage.id),
      blockers: blockers.filter(b => b.stageId === stage.id && !b.isResolved),
    }));

    return {
      workflow: wf,
      stages: stagesWithTasks,
      activeBlockers: blockers.filter(b => !b.isResolved),
      pendingReviews: reviews.filter(r => r.status === ReviewStatus.Pending),
      pendingHandoffs: handoffs.filter(h => h.isApproved === null),
      artifacts,
      decisions,
    };
  }

  /** Build the detailed view payload for a single task. */
  private async buildTaskDetail(workflowId: string, taskId: string): Promise<Record<string, unknown>> {
    const tasks = await this.storage.loadTasks(workflowId);
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task "${taskId}" not found in workflow "${workflowId}".`);

    const blockers = (await this.storage.loadBlockers(workflowId)).filter(b => b.taskId === taskId);
    const reviews = (await this.storage.loadReviews(workflowId)).filter(r => r.taskId === taskId);
    const events = (await this.storage.loadEvents(workflowId)).filter(e => e.taskId === taskId);

    // Resolve parent and children
    const parentTask = task.parentTaskId
      ? tasks.find(t => t.id === task.parentTaskId) ?? null
      : null;
    const childTasks = tasks.filter(t => task.childTaskIds.includes(t.id));

    // Handoff that triggered this task
    let triggeringHandoff = null;
    if (task.handoffRequestId) {
      const handoffs = await this.storage.loadHandoffSnapshots(workflowId);
      triggeringHandoff = handoffs.find(h => h.id === task.handoffRequestId) ?? null;
    }

    return {
      task,
      parentTask,
      childTasks,
      blockers,
      reviews,
      events,
      triggeringHandoff,
    };
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────────

  private getHtmlContent(webview: vscode.Webview): string {
    const boardUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'workflow-board.html')
    );
    // For security, load the board HTML by embedding it directly (not via src)
    // instead of pointing to an external file, since webview security requires
    // serving local files via the extension's own media directory.
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'workflow-board.html').fsPath;
    try {
      let html = fs.readFileSync(htmlPath, 'utf8');
      // Replace the VS Code API acquisition placeholder
      html = html.replace('__CSP_SOURCE__', webview.cspSource);
      return html;
    } catch {
      return this.getFallbackHtml(webview);
    }
  }

  private getFallbackHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
  <title>Workflow Board</title>
  <style>body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }</style>
</head>
<body>
  <p>Workflow board loading... If this persists, check that <code>media/workflow-board.html</code> exists in the extension package.</p>
</body>
</html>`;
  }

  private post(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }
}
