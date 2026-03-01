import * as vscode from 'vscode';
import { AgentManager } from '../agents/AgentManager';
import { AgentRunner } from '../agents/AgentRunner';
import { UndoManager } from '../agents/UndoManager';
import { AuditLogger } from '../audit/AuditLogger';
import { ConfigManager } from '../config/ConfigManager';
import { DiffManager } from '../ui/DiffManager';
import { ApprovalDialog } from '../ui/ApprovalDialog';
import { StatusBar } from '../ui/StatusBar';
import { ProviderType, ThoughtEvent } from '../types';
import type { WorkflowEngine } from '../workflow/WorkflowEngine';
import type { WorkflowStorage } from '../workflow/WorkflowStorage';
import { getAppData } from '../data/DataStore';

export type MessageToWebview =
  | { type: 'text_delta'; agentId: string; delta: string }
  | { type: 'text_done'; agentId: string }
  | { type: 'thought'; agentId: string; event: ThoughtEvent }
  | { type: 'error'; message: string }
  | { type: 'agent_changed'; agentId: string; agentName: string; providerType: string; model: string; usingDefault: boolean }
  | { type: 'agent_list'; agents: { id: string; name: string; category: string; providerType: string; model: string; configured: boolean; usesDefault: boolean }[]; activeAgentId?: string }
  | { type: 'undo_result'; message: string }
  | { type: 'token_usage'; lastInputTokens: number; lastOutputTokens: number; sessionInputTokens: number; sessionOutputTokens: number; model: string }
  | { type: 'model_switched'; model: string }
  | { type: 'wf_command_result'; message: string };

export class ChatController {
  private _activeAgentId: string | undefined;
  private diffManager = new DiffManager();
  private approvalDialog = new ApprovalDialog();
  private readonly _subscribers = new Set<(msg: MessageToWebview) => void>();
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private currentModel = '';

  // Optional workflow engine — injected after construction when workflow features are active.
  private workflowEngine?: WorkflowEngine;
  private workflowStorage?: WorkflowStorage;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly configManager: ConfigManager,
    private readonly auditLogger: AuditLogger,
    private readonly statusBar: StatusBar,
    private readonly runner: AgentRunner,
    private readonly undoManager: UndoManager
  ) {}

  /** Inject workflow engine after construction (called from extension.ts when workflow is enabled). */
  setWorkflowEngine(engine: WorkflowEngine, storage: WorkflowStorage): void {
    this.workflowEngine = engine;
    this.workflowStorage = storage;
  }

  get activeAgentName(): string | undefined {
    if (!this._activeAgentId) {
      return undefined;
    }
    return this.agentManager.getAgent(this._activeAgentId)?.name;
  }

  /** Subscribe to chat messages. Returns an unsubscribe function. */
  addSubscriber(cb: (msg: MessageToWebview) => void): () => void {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  async handleUserMessage(rawMessage: string): Promise<void> {
    // Handle /undo command
    if (rawMessage.trim().toLowerCase() === '/undo') {
      if (!this._activeAgentId) {
        this.post({ type: 'error', message: 'No active agent selected.' });
        return;
      }
      const result = await this.undoManager.undo(this._activeAgentId);
      this.post({ type: 'undo_result', message: result });
      return;
    }

    // Handle /artifact command
    if (rawMessage.trim().startsWith('/artifact')) {
      await this.handleArtifactCommand(rawMessage.trim());
      return;
    }

    // Handle /wf-* workflow management commands
    if (rawMessage.trim().startsWith('/wf-')) {
      await this.handleWorkflowCommand(rawMessage.trim());
      return;
    }

    // Parse @agent-name mention
    const mentionMatch = rawMessage.match(/^@([\w-]+)\s*/);
    if (mentionMatch) {
      const mentionedId = mentionMatch[1];
      const agent = this.agentManager.getAgent(mentionedId);
      if (agent) {
        await this.setActiveAgent(mentionedId);
      }
    }

    const agentId = this._activeAgentId;
    if (!agentId) {
      this.post({
        type: 'error',
        message: 'No agent selected. Use @agent-name in your message or run "Bormagi: Select Active Agent".'
      });
      return;
    }

    const agent = this.agentManager.getAgent(agentId);
    const providerType = agent?.provider.type ?? '';
    const model = agent?.provider.model ?? this.currentModel;

    try {
      await this.runner.run(
        agentId,
        rawMessage,
        (delta) => this.post({ type: 'text_delta', agentId, delta }),
        (event) => this.post({ type: 'thought', agentId, event }),
        async (prompt) => this.approvalDialog.request(prompt),
        async (filePath, original, proposed) =>
          this.diffManager.showAndApprove(filePath, original, proposed),
        (usage) => {
          this.sessionInputTokens += usage.inputTokens;
          this.sessionOutputTokens += usage.outputTokens;
          const costUsd = this.estimateCost(model, this.sessionInputTokens, this.sessionOutputTokens);
          void this.auditLogger.logTokenUsage(agentId, providerType, model, usage.inputTokens, usage.outputTokens, costUsd);
          this.post({
            type: 'token_usage',
            lastInputTokens: usage.inputTokens,
            lastOutputTokens: usage.outputTokens,
            sessionInputTokens: this.sessionInputTokens,
            sessionOutputTokens: this.sessionOutputTokens,
            model
          });
        }
      );
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    } finally {
      this.post({ type: 'text_done', agentId });
    }
  }

  async handleWebviewMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'switch_model': {
        const agent = this._activeAgentId ? this.agentManager.getAgent(this._activeAgentId) : undefined;
        if (!agent) break;
        const models = getAppData().providerModels[agent.provider.type as ProviderType] ?? [];
        const chosen = await vscode.window.showQuickPick(models, {
          title: `Switch model — ${agent.provider.type}`,
          placeHolder: `Current: ${agent.provider.model}`
        });
        if (chosen) {
          agent.provider.model = chosen;   // session-only override
          this.currentModel = chosen;
          this.post({ type: 'model_switched', model: chosen });
        }
        break;
      }
    }
  }

  async setActiveAgent(agentId: string): Promise<void> {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      return;
    }
    this._activeAgentId = agentId;
    this.sessionInputTokens = 0;
    this.sessionOutputTokens = 0;
    this.statusBar.update(agent.name);
    await this.auditLogger.logAgentSwitch(agentId);

    // Resolve effective provider (mirrors AgentRunner fallback logic)
    const explicitDefault = !!(agent.useDefaultProvider || !agent.provider?.type);
    let effectiveType  = agent.provider.type;
    let effectiveModel = agent.provider.model;
    let usingDefault   = false;

    if (explicitDefault) {
      const def = await this.configManager.readDefaultProvider();
      if (def) { effectiveType = def.type; effectiveModel = def.model; }
      usingDefault = true;
    } else {
      // Auto-fallback: no own key + workspace default available
      const needsOwnKey = (agent.provider?.auth_method ?? 'api_key') === 'api_key';
      if (needsOwnKey) {
        const ownKey = await this.agentManager.getApiKey(agent.id);
        if (!ownKey) {
          const def = await this.configManager.readDefaultProvider();
          if (def?.type) {
            const defNeedsKey = (def.auth_method ?? 'api_key') === 'api_key';
            const defKey = defNeedsKey ? await this.agentManager.getApiKey('__default__') : 'ok';
            if (defKey) { effectiveType = def.type; effectiveModel = def.model; usingDefault = true; }
          }
        }
      }
    }
    this.currentModel = effectiveModel;

    this.post({
      type: 'agent_changed',
      agentId,
      agentName: agent.name,
      providerType: effectiveType,
      model: effectiveModel,
      usingDefault
    });
  }

  async refreshAgentList(): Promise<void> {
    await this.agentManager.loadAgents();
    const defaultProvider = await this.configManager.readDefaultProvider();
    const defaultKeySet = !!(await this.agentManager.getApiKey('__default__'));

    const agents = await Promise.all(this.agentManager.listAgents().map(async a => {
      const explicitDefault = !!(a.useDefaultProvider || !a.provider?.type);

      let effectiveType: string;
      let effectiveModel: string;
      let configured: boolean;
      let usesDefault: boolean;

      if (explicitDefault) {
        effectiveType  = defaultProvider?.type  ?? a.provider.type;
        effectiveModel = defaultProvider?.model ?? a.provider.model;
        const needsKey = (defaultProvider?.auth_method ?? 'api_key') === 'api_key';
        configured = !needsKey || (!!defaultProvider && defaultKeySet);
        usesDefault = true;
      } else {
        const needsOwnKey = (a.provider?.auth_method ?? 'api_key') === 'api_key';
        const ownKey = needsOwnKey ? await this.agentManager.getApiKey(a.id) : 'ok';

        const defaultNeedsKey = (defaultProvider?.auth_method ?? 'api_key') === 'api_key';
        const hasUsableDefault = !!defaultProvider?.type && (!defaultNeedsKey || defaultKeySet);

        if (!ownKey && needsOwnKey && hasUsableDefault && defaultProvider) {
          // Auto-fallback: no own key but workspace default is available
          effectiveType  = defaultProvider.type;
          effectiveModel = defaultProvider.model;
          configured = true;
          usesDefault = true;
        } else {
          effectiveType  = a.provider.type;
          effectiveModel = a.provider.model;
          configured = !needsOwnKey || !!ownKey;
          usesDefault = false;
        }
      }

      return { id: a.id, name: a.name, category: a.category, providerType: effectiveType, model: effectiveModel, configured, usesDefault };
    }));

    this.post({ type: 'agent_list', agents, activeAgentId: this._activeAgentId });
  }

  private async handleArtifactCommand(raw: string): Promise<void> {
    const { artifactCommands, artifactPrompts } = getAppData();
    const artifactIds = artifactCommands.map(c => c.id);
    const parts = raw.split(/\s+/);
    let artifactType = parts[1];

    if (!artifactType || !artifactIds.includes(artifactType)) {
      const picked = await vscode.window.showQuickPick(
        artifactCommands.map(c => ({ label: c.id, description: c.label })),
        { title: 'Extract artifact from conversation', placeHolder: 'Choose artifact type' }
      );
      artifactType = picked?.label ?? '';
      if (!artifactType) {
        return;
      }
    }

    const prompt = artifactPrompts[artifactType] ?? `Generate a ${artifactType} based on our conversation above.`;
    await this.handleUserMessage(`[Artifact extraction — ${artifactType}]\n${prompt}`);
  }

  // ─── WF-402: Workflow management commands ─────────────────────────────────────

  private async handleWorkflowCommand(raw: string): Promise<void> {
    if (!this.workflowEngine || !this.workflowStorage) {
      this.post({
        type: 'wf_command_result',
        message: '⚠ Workflow engine is not available in this session. Ensure a workspace with a `.bormagi/workflows/` directory is open.'
      });
      return;
    }

    const parts = raw.split(/\s+/);
    const subcommand = parts[0].slice(4); // strip leading '/wf-'

    switch (subcommand) {
      case 'list':
        await this.wfList();
        break;
      case 'status':
        await this.wfStatus(parts[1]);
        break;
      case 'resume':
        await this.wfResume(parts[1]);
        break;
      case 'cancel':
        await this.wfCancel(parts[1], parts.slice(2).join(' '));
        break;
      case 'reassign':
        await this.wfReassign(parts[1], parts[2]);
        break;
      default:
        this.post({
          type: 'wf_command_result',
          message: [
            'Available workflow commands:',
            '  /wf-list                             — list all active workflows',
            '  /wf-status [workflowId]              — show workflow summary (prompts if omitted)',
            '  /wf-resume <taskId>                  — resume a paused/waiting task',
            '  /wf-cancel <taskId> [reason]         — cancel a task (with confirmation)',
            '  /wf-reassign <taskId> <newAgentId>   — reassign task to a different agent',
          ].join('\n')
        });
    }
  }

  private async wfList(): Promise<void> {
    const ids = await this.workflowStorage!.listWorkflowIds();
    if (ids.length === 0) {
      this.post({ type: 'wf_command_result', message: 'No workflows found in this workspace.' });
      return;
    }

    const lines: string[] = [`Found ${ids.length} workflow(s):\n`];
    for (const id of ids) {
      const wf = await this.workflowStorage!.loadWorkflow(id);
      if (wf) {
        lines.push(`  • [${wf.status.toUpperCase()}] ${wf.title} (${wf.id})`);
      }
    }
    this.post({ type: 'wf_command_result', message: lines.join('\n') });
  }

  private async wfStatus(workflowId?: string): Promise<void> {
    const id = await this.resolveWorkflowId(workflowId);
    if (!id) return;

    try {
      const summary = await this.workflowEngine!.generateWorkflowSummary(id);
      this.post({ type: 'wf_command_result', message: summary.markdownSummary });
    } catch (err) {
      this.post({ type: 'wf_command_result', message: `Error: ${String(err)}` });
    }
  }

  private async wfResume(taskId?: string): Promise<void> {
    if (!taskId) {
      this.post({ type: 'wf_command_result', message: 'Usage: /wf-resume <taskId>' });
      return;
    }

    const workflowId = await this.resolveWorkflowIdForTask(taskId);
    if (!workflowId) {
      this.post({ type: 'wf_command_result', message: `Task "${taskId}" not found in any workflow.` });
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Resume task "${taskId}" in workflow "${workflowId}"?`,
      { modal: true },
      'Resume'
    );
    if (confirmed !== 'Resume') return;

    try {
      // resumeAfterReview is the canonical resume path; for manual resume we pass the taskId as the reviewId
      // which resolves the waiting-review state. For WaitingChild tasks, callers should cancel the child.
      const resumed = await this.workflowEngine!.resumeAfterReview(workflowId, taskId);
      const msg = resumed
        ? `Task "${resumed.title ?? taskId}" resumed successfully.`
        : `Task "${taskId}" could not be resumed (check its current status with /wf-status).`;
      await this.auditLogger.logAgentSwitch(`wf-resume:${taskId}`);
      this.post({ type: 'wf_command_result', message: msg });
    } catch (err) {
      this.post({ type: 'wf_command_result', message: `Error resuming task: ${String(err)}` });
    }
  }

  private async wfCancel(taskId?: string, reason?: string): Promise<void> {
    if (!taskId) {
      this.post({ type: 'wf_command_result', message: 'Usage: /wf-cancel <taskId> [reason]' });
      return;
    }

    const workflowId = await this.resolveWorkflowIdForTask(taskId);
    if (!workflowId) {
      this.post({ type: 'wf_command_result', message: `Task "${taskId}" not found in any workflow.` });
      return;
    }

    const finalReason = reason?.trim() || await vscode.window.showInputBox({
      title: `Cancel task "${taskId}"`,
      prompt: 'Enter cancellation reason (required)',
      placeHolder: 'e.g. Superseded by new requirements'
    });
    if (!finalReason) return;

    const confirmed = await vscode.window.showWarningMessage(
      `Cancel task "${taskId}"? This cannot be undone.`,
      { modal: true },
      'Cancel Task'
    );
    if (confirmed !== 'Cancel Task') return;

    try {
      await this.workflowEngine!.cancelTask(workflowId, taskId, finalReason, 'human');
      await this.auditLogger.logAgentSwitch(`wf-cancel:${taskId}`);
      this.post({ type: 'wf_command_result', message: `Task "${taskId}" cancelled. Reason: ${finalReason}` });
    } catch (err) {
      this.post({ type: 'wf_command_result', message: `Error cancelling task: ${String(err)}` });
    }
  }

  private async wfReassign(taskId?: string, newAgentId?: string): Promise<void> {
    if (!taskId || !newAgentId) {
      this.post({ type: 'wf_command_result', message: 'Usage: /wf-reassign <taskId> <newAgentId>' });
      return;
    }

    const newAgent = this.agentManager.getAgent(newAgentId);
    if (!newAgent) {
      this.post({ type: 'wf_command_result', message: `Agent "${newAgentId}" not found. Check the agent ID with the agent list.` });
      return;
    }

    const workflowId = await this.resolveWorkflowIdForTask(taskId);
    if (!workflowId) {
      this.post({ type: 'wf_command_result', message: `Task "${taskId}" not found in any workflow.` });
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Reassign task "${taskId}" to agent "${newAgent.name}"?`,
      { modal: true },
      'Reassign'
    );
    if (confirmed !== 'Reassign') return;

    try {
      const tasks = await this.workflowStorage!.loadTasks(workflowId);
      const index = tasks.findIndex(t => t.id === taskId);
      if (index === -1) {
        this.post({ type: 'wf_command_result', message: `Task "${taskId}" not found in storage.` });
        return;
      }
      const previous = tasks[index].ownerAgentId;
      tasks[index] = { ...tasks[index], ownerAgentId: newAgentId };
      await this.workflowStorage!.saveTasks(workflowId, tasks);
      await this.auditLogger.logAgentSwitch(`wf-reassign:${taskId}:${newAgentId}`);
      this.post({
        type: 'wf_command_result',
        message: `Task "${taskId}" reassigned from "${previous}" to "${newAgentId}" (${newAgent.name}).`
      });
    } catch (err) {
      this.post({ type: 'wf_command_result', message: `Error reassigning task: ${String(err)}` });
    }
  }

  // ─── Workflow command helpers ──────────────────────────────────────────────────

  /** Resolve a workflowId — prompts with quick-pick if not provided or ambiguous. */
  private async resolveWorkflowId(workflowId?: string): Promise<string | undefined> {
    if (workflowId) return workflowId;

    const ids = await this.workflowStorage!.listWorkflowIds();
    if (ids.length === 0) {
      this.post({ type: 'wf_command_result', message: 'No workflows found in this workspace.' });
      return undefined;
    }
    if (ids.length === 1) return ids[0];

    const items = await Promise.all(ids.map(async id => {
      const wf = await this.workflowStorage!.loadWorkflow(id);
      return { label: wf ? `${wf.title} (${wf.status})` : id, id };
    }));

    const chosen = await vscode.window.showQuickPick(
      items.map(i => i.label),
      { title: 'Select workflow', placeHolder: 'Choose a workflow' }
    );
    return chosen ? items.find(i => i.label === chosen)?.id : undefined;
  }

  /** Find which workflow owns a given task by scanning all workflows. */
  private async resolveWorkflowIdForTask(taskId: string): Promise<string | undefined> {
    const ids = await this.workflowStorage!.listWorkflowIds();
    for (const id of ids) {
      const tasks = await this.workflowStorage!.loadTasks(id);
      if (tasks.some(t => t.id === taskId)) return id;
    }
    return undefined;
  }

  private estimateCost(model: string, totalInputTokens: number, totalOutputTokens: number): number {
    // USD per 1M tokens — loaded from data/models.json
    const p = getAppData().pricing[model];
    if (!p) return 0;
    return (totalInputTokens / 1e6) * p.in + (totalOutputTokens / 1e6) * p.out;
  }

  private post(msg: MessageToWebview): void {
    this._subscribers.forEach(cb => { try { cb(msg); } catch { /* disposed */ } });
  }
}
