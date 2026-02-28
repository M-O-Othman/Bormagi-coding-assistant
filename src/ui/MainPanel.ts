import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ChatController } from '../chat/ChatController';
import type { AgentManager } from '../agents/AgentManager';
import type { ConfigManager } from '../config/ConfigManager';
import type { SecretsManager } from '../config/SecretsManager';
import type { WorkflowEngine } from '../workflow/WorkflowEngine';
import type { WorkflowStorage } from '../workflow/WorkflowStorage';
import type { ArtifactRegistry } from '../workflow/ArtifactRegistry';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import { WorkflowStatus, TaskStatus } from '../workflow/enums';
import type { HandoffRequest, ReviewRequest, Blocker } from '../workflow/types';
import { ReviewManager } from '../workflow/ReviewManager';
import type { ReviewOutcome } from '../workflow/ReviewManager';
import { parseTemplate } from '../workflow/WorkflowTemplate';

// ─── Services bundle ──────────────────────────────────────────────────────────

interface MainPanelServices {
  extensionUri: vscode.Uri;
  extensionPath: string;
  chatController: ChatController;
  agentManager: AgentManager;
  configManager: ConfigManager;
  secretsManager: SecretsManager;
}

// ─── MainPanel ────────────────────────────────────────────────────────────────

export class MainPanel {
  public static currentPanel: MainPanel | undefined;
  private static _services: MainPanelServices | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _svc: MainPanelServices;
  private _disposables: vscode.Disposable[] = [];
  private _chatUnsub?: () => void;

  /** Optional workflow services — injected after the engine is created. */
  private _workflowEngine?: WorkflowEngine;
  private _workflowStorage?: WorkflowStorage;
  private _artifactRegistry?: ArtifactRegistry;

  // ─── Static API ─────────────────────────────────────────────────────────────

  static configure(svc: MainPanelServices): void {
    MainPanel._services = svc;
  }

  static createOrShow(): void {
    if (!MainPanel._services) {
      vscode.window.showErrorMessage('Bormagi: Dashboard not yet configured.');
      return;
    }
    if (MainPanel.currentPanel) {
      MainPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'bormagi.dashboard',
      'Bormagi Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [MainPanel._services.extensionUri],
      }
    );
    MainPanel.currentPanel = new MainPanel(panel, MainPanel._services);
  }

  /** Inject workflow services (called from extension.ts when workflow is enabled). */
  setWorkflowServices(engine: WorkflowEngine, storage: WorkflowStorage, registry: ArtifactRegistry): void {
    this._workflowEngine = engine;
    this._workflowStorage = storage;
    this._artifactRegistry = registry;
  }

  // ─── Constructor ──────────────────────────────────────────────────────────

  private constructor(panel: vscode.WebviewPanel, svc: MainPanelServices) {
    this._panel = panel;
    this._svc = svc;

    this._panel.webview.html = this._getHtml();

    // Subscribe to ChatController so streaming messages reach the main panel too
    this._chatUnsub = svc.chatController.addSubscriber(msg => {
      try { void this._panel.webview.postMessage(msg); } catch { /* disposed */ }
    });

    this._panel.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg as Record<string, unknown>),
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  // ─── Message dispatcher ───────────────────────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    switch (type) {
      // Boot
      case 'init':
        await this._sendInit();
        break;

      // Chat tab
      case 'chat_send':
        await this._svc.chatController.handleUserMessage(msg.text as string);
        break;
      case 'chat_select_agent':
        await this._svc.chatController.setActiveAgent(msg.agentId as string);
        break;
      case 'chat_refresh_agents':
        await this._svc.chatController.refreshAgentList();
        break;
      case 'chat_switch_model':
        await this._svc.chatController.handleWebviewMessage({ type: 'switch_model' });
        break;

      // Work tab
      case 'get_work_summary':
        await this._sendWorkSummary();
        break;

      // Workflows tab
      case 'get_board_data':
        await this._sendBoardData();
        break;
      case 'create_workflow':
        await this._createWorkflow(msg);
        break;
      case 'get_task_detail':
        await this._sendTaskDetail(msg.workflowId as string, msg.taskId as string);
        break;
      case 'cancel_task':
        await this._cancelTask(msg.workflowId as string, msg.taskId as string);
        break;

      // Review tab
      case 'get_review_items':
        await this._sendReviewItems();
        break;
      case 'approve_handoff':
        await this._setHandoffStatus(msg.workflowId as string, msg.handoffId as string, 'approved');
        break;
      case 'reject_handoff':
        await this._setHandoffStatus(msg.workflowId as string, msg.handoffId as string, 'rejected', msg.reason as string | undefined);
        break;
      case 'approve_review':
        await this._completeReview(
          msg.workflowId as string,
          msg.reviewId as string,
          msg.outcome as string,
          msg.note as string | undefined
        );
        break;
      case 'resolve_blocker':
        await this._resolveBlocker(msg.workflowId as string, msg.blockerId as string, msg.note as string);
        break;

      // Setup tab
      case 'get_setup_data':
        await this._sendSetupData();
        break;
      case 'open_agent_settings':
        AgentSettingsPanel.createOrShow(
          this._svc.extensionUri,
          this._svc.agentManager,
          this._svc.secretsManager,
          this._svc.configManager,
          msg.mode as 'list' | 'new' | 'edit' | undefined
        );
        break;
      case 'install_predefined_agents':
        await vscode.commands.executeCommand('bormagi.installPredefinedAgents');
        break;
      case 'initialise_workspace':
        await vscode.commands.executeCommand('bormagi.initialiseWorkspace');
        break;
      case 'show_audit_log':
        await vscode.commands.executeCommand('bormagi.showAuditLog');
        break;
      case 'open_file':
        await this._openFile(msg.path as string);
        break;
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  private async _sendInit(): Promise<void> {
    await this._svc.chatController.refreshAgentList();
    await this._sendWorkSummary();
    await this._sendSetupData();
  }

  // ─── Work tab ─────────────────────────────────────────────────────────────

  private async _sendWorkSummary(): Promise<void> {
    if (!this._workflowStorage) {
      this._post({ type: 'work_summary', data: null });
      return;
    }

    try {
      const ids = await this._workflowStorage.listWorkflowIds();
      const workflows = (await Promise.all(ids.map(id => this._workflowStorage!.loadWorkflow(id)))).filter(Boolean);
      const active = workflows.filter(w => w!.status === WorkflowStatus.Active || w!.status === WorkflowStatus.Blocked);

      if (active.length === 0) {
        this._post({ type: 'work_summary', data: null });
        return;
      }

      const wf = active[0]!;
      const tasks   = await this._workflowStorage.loadTasks(wf.id);
      const stages  = await this._workflowStorage.loadStages(wf.id);
      const blockers = (await this._workflowStorage.loadBlockers(wf.id)).filter(b => !b.isResolved);
      const reviews  = (await this._workflowStorage.loadReviews(wf.id)).filter(r => r.status === 'pending');
      const handoffs = (await this._workflowStorage.loadHandoffSnapshots(wf.id)).filter(h => h.isApproved === null);

      const currentTask = tasks.find(t => t.status === TaskStatus.Active || t.status === TaskStatus.WaitingReview) ?? null;

      const attentionItems = [
        ...blockers.map(b => ({ type: 'blocker',  title: `Blocker: ${b.reason.substring(0, 60)}`, severity: b.severity, taskId: b.taskId })),
        ...reviews.map(r  => ({ type: 'review',   title: 'QA Review pending', taskId: r.taskId })),
        ...handoffs.map(h => ({ type: 'handoff',  title: `Handoff: ${(h.objective ?? 'Delegation').substring(0, 60)}`, taskId: h.taskId })),
      ];

      this._post({
        type: 'work_summary',
        data: {
          workflowId:   wf.id,
          title:        wf.title,
          status:       wf.status,
          stages:       stages.map(s => ({ id: s.id, name: s.templateStageId, status: s.status })),
          currentTask:  currentTask ? { id: currentTask.id, title: currentTask.title, status: currentTask.status, ownerAgentId: currentTask.ownerAgentId } : null,
          attentionItems,
          totalWorkflows: workflows.length,
          activeCount: active.length,
        }
      });
    } catch (err) {
      this._post({ type: 'work_summary', data: null });
      this._notify(`Work summary error: ${err}`, 'error');
    }
  }

  // ─── Board data ───────────────────────────────────────────────────────────

  private async _sendBoardData(): Promise<void> {
    if (!this._workflowStorage) {
      this._post({ type: 'board_data', columns: { backlog: [], active: [], waiting_review: [], blocked: [], done: [] }, workflows: [] });
      return;
    }

    try {
      const ids = await this._workflowStorage.listWorkflowIds();
      const allTasks: object[] = [];
      const wfList: object[] = [];

      for (const id of ids) {
        const wf = await this._workflowStorage.loadWorkflow(id);
        if (!wf) continue;
        wfList.push({ id: wf.id, title: wf.title, status: wf.status });
        const tasks = await this._workflowStorage.loadTasks(id);
        for (const t of tasks) {
          allTasks.push({ id: t.id, workflowId: id, workflowTitle: wf.title, title: t.title, status: t.status, ownerAgentId: t.ownerAgentId });
        }
      }

      const at = allTasks as Array<{ status: string }>;
      this._post({
        type: 'board_data',
        workflows: wfList,
        columns: {
          backlog:        at.filter(t => t.status === TaskStatus.Queued),
          active:         at.filter(t => t.status === TaskStatus.Active),
          waiting_review: at.filter(t => t.status === TaskStatus.WaitingReview || t.status === ('waiting_child' as string)),
          blocked:        at.filter(t => t.status === TaskStatus.Blocked),
          done:           at.filter(t => t.status === TaskStatus.Completed || t.status === TaskStatus.Cancelled || t.status === TaskStatus.Failed),
        }
      });
    } catch (err) {
      this._notify(`Board error: ${err}`, 'error');
    }
  }

  // ─── Create workflow ──────────────────────────────────────────────────────

  private async _createWorkflow(msg: Record<string, unknown>): Promise<void> {
    if (!this._workflowEngine) {
      this._post({ type: 'workflow_created', error: 'Workflow engine not initialised. Run "Bormagi: Initialise Workspace" first.' });
      return;
    }

    // Load the predefined template from the extension package
    const templateId = msg.templateId as string;
    const templatePath = path.join(this._svc.extensionPath, 'predefined-workflows', `${templateId}.json`);

    try {
      const raw = fs.readFileSync(templatePath, 'utf8');
      const template = parseTemplate(raw, templatePath);
      await this._workflowEngine.createWorkflow({
        template,
        title: msg.title as string,
        humanOwner: msg.humanOwner as string || 'human',
      });
      this._post({ type: 'workflow_created', success: true });
      await this._sendBoardData();
    } catch (err) {
      this._post({ type: 'workflow_created', error: String(err) });
    }
  }

  // ─── Task detail ──────────────────────────────────────────────────────────

  private async _sendTaskDetail(workflowId: string, taskId: string): Promise<void> {
    if (!this._workflowStorage) return;
    try {
      const tasks = await this._workflowStorage.loadTasks(workflowId);
      const task  = tasks.find(t => t.id === taskId);
      if (!task) { this._post({ type: 'task_detail', error: 'Task not found' }); return; }
      const blockers = (await this._workflowStorage.loadBlockers(workflowId)).filter(b => b.taskId === taskId && !b.isResolved);
      this._post({ type: 'task_detail', data: { ...task, workflowId, blockers } });
    } catch (err) {
      this._post({ type: 'task_detail', error: String(err) });
    }
  }

  // ─── Cancel task ──────────────────────────────────────────────────────────

  private async _cancelTask(workflowId: string, taskId: string): Promise<void> {
    if (!this._workflowEngine) return;
    const reason = await vscode.window.showInputBox({
      title: 'Cancel Task',
      prompt: 'Enter cancellation reason (required)',
      placeHolder: 'e.g. Superseded by new requirements',
    });
    if (!reason) return;
    try {
      await this._workflowEngine.cancelTask(workflowId, taskId, reason, 'human');
      this._notify('Task cancelled', 'info');
      await this._sendBoardData();
    } catch (err) {
      this._notify(`Cancel failed: ${err}`, 'error');
    }
  }

  // ─── Review items ─────────────────────────────────────────────────────────

  private async _sendReviewItems(): Promise<void> {
    if (!this._workflowStorage) {
      this._post({ type: 'review_items', items: [] });
      return;
    }

    try {
      const ids  = await this._workflowStorage.listWorkflowIds();
      const items: object[] = [];

      for (const id of ids) {
        const wf = await this._workflowStorage.loadWorkflow(id);
        if (!wf) continue;

        const handoffs: HandoffRequest[] = await this._workflowStorage.loadHandoffSnapshots(id);
        for (const h of handoffs.filter(h => h.isApproved === null)) {
          items.push({ type: 'handoff', id: h.id, workflowId: id, workflowTitle: wf.title, title: 'Handoff request', description: h.objective ?? 'Agent delegation request', fromAgent: h.fromAgentId, toAgent: h.toAgentId, taskId: h.taskId });
        }

        const reviews: ReviewRequest[] = await this._workflowStorage.loadReviews(id);
        for (const r of reviews.filter(r => r.status === 'pending')) {
          items.push({ type: 'qa_review', id: r.id, workflowId: id, workflowTitle: wf.title, title: 'QA Review', description: r.itemUnderReview ?? 'Review requested', taskId: r.taskId, requestedBy: r.requestingAgentId });
        }

        const blockers: Blocker[] = await this._workflowStorage.loadBlockers(id);
        for (const b of blockers.filter(b => !b.isResolved)) {
          items.push({ type: 'blocker', id: b.id, workflowId: id, workflowTitle: wf.title, title: 'Blocker', description: b.reason, severity: b.severity, taskId: b.taskId });
        }
      }

      this._post({ type: 'review_items', items });
    } catch (err) {
      this._post({ type: 'review_items', items: [] });
      this._notify(`Review items error: ${err}`, 'error');
    }
  }

  // ─── Handoff ──────────────────────────────────────────────────────────────

  private async _setHandoffStatus(workflowId: string, handoffId: string, status: 'approved' | 'rejected', _reason?: string): Promise<void> {
    if (!this._workflowStorage) return;
    try {
      const handoffs = await this._workflowStorage.loadHandoffSnapshots(workflowId);
      const idx = handoffs.findIndex(h => h.id === handoffId);
      if (idx < 0) return;
      handoffs[idx] = { ...handoffs[idx], isApproved: status === 'approved' };
      await this._workflowStorage.saveHandoffSnapshots(workflowId, handoffs);
      await this._sendReviewItems();
      this._notify(status === 'approved' ? 'Handoff approved' : 'Handoff rejected', status === 'approved' ? 'success' : 'info');
    } catch (err) {
      this._notify(`Handoff update failed: ${err}`, 'error');
    }
  }

  // ─── QA Review ───────────────────────────────────────────────────────────

  private async _completeReview(workflowId: string, reviewId: string, outcome: string, note?: string): Promise<void> {
    if (!this._workflowStorage) return;
    try {
      const validOutcomes: ReviewOutcome[] = ['approved', 'approved_with_comments', 'rejected'];
      const safeOutcome: ReviewOutcome = validOutcomes.includes(outcome as ReviewOutcome) ? outcome as ReviewOutcome : 'approved';
      const rm = new ReviewManager(this._workflowStorage);
      await rm.completeReview(workflowId, reviewId, safeOutcome, note);
      await this._sendReviewItems();
      this._notify('Review completed', 'success');
    } catch (err) {
      this._notify(`Review failed: ${err}`, 'error');
    }
  }

  // ─── Blocker ─────────────────────────────────────────────────────────────

  private async _resolveBlocker(workflowId: string, blockerId: string, note: string): Promise<void> {
    if (!this._workflowEngine) return;
    try {
      await this._workflowEngine.resolveBlocker(workflowId, blockerId, note, 'human');
      await this._sendReviewItems();
      this._notify('Blocker resolved', 'success');
    } catch (err) {
      this._notify(`Resolve failed: ${err}`, 'error');
    }
  }

  // ─── Setup data ───────────────────────────────────────────────────────────

  private async _sendSetupData(): Promise<void> {
    const agents = this._svc.agentManager.listAgents().map(a => ({
      id: a.id, name: a.name, category: a.category,
      description: a.description, providerType: a.provider.type, model: a.provider.model, enabled: a.enabled,
    }));
    const proj = await this._svc.configManager.readProjectConfig();
    this._post({ type: 'setup_data', agents, workspaceName: proj?.project.name ?? '', initialized: !!proj });
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  private async _openFile(filePath: string): Promise<void> {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } catch {
      vscode.window.showErrorMessage(`Bormagi: Cannot open ${filePath}`);
    }
  }

  private _post(msg: Record<string, unknown>): void {
    try { void this._panel.webview.postMessage(msg); } catch { /* disposed */ }
  }

  private _notify(message: string, kind: string): void {
    this._post({ type: 'notification', message, kind });
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  private _getHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const mediaPath = path.join(this._svc.extensionPath, 'media', 'main.html');
    try {
      const html = fs.readFileSync(mediaPath, 'utf8');
      return html.replace(/\$\{nonce\}/g, nonce);
    } catch {
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;">
        <h2>Bormagi Dashboard</h2>
        <p>Could not load main.html. Please rebuild the extension (F5).</p>
      </body></html>`;
    }
  }

  // ─── Dispose ─────────────────────────────────────────────────────────────

  private _dispose(): void {
    MainPanel.currentPanel = undefined;
    this._chatUnsub?.();
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}
