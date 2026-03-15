import * as vscode from 'vscode';
import { AgentManager } from '../agents/AgentManager';
import { AgentRunner } from '../agents/AgentRunner';
import { UndoManager } from '../agents/UndoManager';
import { AuditLogger } from '../audit/AuditLogger';
import { ConfigManager } from '../config/ConfigManager';
import { DiffManager } from '../ui/DiffManager';
import { StatusBar } from '../ui/StatusBar';
import { ProviderType, ThoughtEvent } from '../types';
import type { WorkflowEngine } from '../workflow/WorkflowEngine';
import type { WorkflowStorage } from '../workflow/WorkflowStorage';
import { getAppData } from '../data/DataStore';
import type { PlanMilestone } from '../context/types';
import { authMethodRequiresCredential } from '../providers/AuthSupport';

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
  | { type: 'wf_command_result'; message: string }
  | { type: 'action_request'; id: string; prompt: string; actions: string[]; kind?: 'edit' | 'command' | 'network' | 'git' | 'external_tool'; reason?: string; scope?: string[]; risk?: 'low' | 'medium' | 'high'; alternatives?: string[] }
  | { type: 'git_status'; status: import('../git/GitService').RepoStatusSnapshot; checkpointId?: string }
  | { type: 'mode_changed'; mode: string; modeLabel: string }
  | { type: 'compaction_notice'; preservedItems: string[]; droppedCount: number }
  | { type: 'plan_artifact'; plan: { id: string; objective: string; milestones: Array<{ id: string; title: string; tasks: string[]; validations: string[]; status: string }>; decisions: string[]; blockers: string[] } }
  | { type: 'diff_summary'; changedFiles: string[]; intent: string; risks?: string[]; checkpointRef?: string }
  | { type: 'checkpoint_created'; checkpointId: string; label: string; changedFiles: string[] }
  | { type: 'resume_state'; taskTitle: string; mode: string; lastSummary: string; nextAction: string; selectedFiles: string[]; checkpointId?: string; planId?: string; blockers: string[] }
  | { type: 'context_update'; items: Array<{ id: string; itemType: string; label: string; source: string; reasonIncluded: string; estimatedTokens?: number; removable: boolean }>; tokenHealth: 'healthy' | 'busy' | 'near-limit' };

// Human-readable mode labels for UI display
const MODE_LABELS: Record<string, string> = {
  ask: 'Ask', plan: 'Plan', code: 'Code',
};

// Slash-command → mode mapping
const SLASH_MODE_COMMANDS: Record<string, string> = {
  '/ask': 'ask', '/plan': 'plan', '/code': 'code',
};

const HELP_TEXT = [
  'Available commands:',
  '  /ask           — Switch to Ask mode (questions only, no file changes)',
  '  /plan          — Switch to Plan mode (writes a plan file for review before coding)',
  '  /code          — Switch to Code mode (implement immediately; plans internally for complex tasks)',
  '  /checkpoint    — Create a manual checkpoint',
  '  /resume        — Resume the latest task or plan',
  '  /clear         — Clear the conversation',
  '  /undo          — Undo last file change',
  '  /artifact      — Extract an artifact from conversation',
  '  /wf-list       — List workflows',
  '  /wf-status     — Show workflow status',
  '  /wf-resume     — Resume a paused workflow task',
  '  /wf-cancel     — Cancel a workflow task',
  '  /wf-reassign   — Reassign a workflow task',
  '  /ralph-loop    — Loop agent until completion signal detected',
  '                   Usage: /ralph-loop "task" --completion-promise "DONE"',
  '  /help          — Show this message',
].join('\n');

export class ChatController {
  private _activeAgentId: string | undefined;
  private diffManager = new DiffManager();
  private readonly _subscribers = new Set<(msg: MessageToWebview) => void>();
  private readonly _pendingActions = new Map<string, (value: string | undefined) => void>();
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private currentModel = '';
  private currentMode = 'code';

  // Optional workflow engine — injected after construction when workflow features are active.
  private workflowEngine?: WorkflowEngine;
  private workflowStorage?: WorkflowStorage;
  private gitPollInterval?: NodeJS.Timeout;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly configManager: ConfigManager,
    private readonly auditLogger: AuditLogger,
    private readonly statusBar: StatusBar,
    private readonly runner: AgentRunner,
    private readonly undoManager: UndoManager
  ) {
    this.startGitPolling();
  }

  private startGitPolling() {
    this.gitPollInterval = setInterval(async () => {
      try {
        const root = this.configManager.rootDir;
        const status = await this.runner.git.getStatus(root);
        this.post({ type: 'git_status', status, checkpointId: undefined });
      } catch {
        // Suppress errors during polling
      }
    }, 5000);
  }

  dispose(): void {
    if (this.gitPollInterval) {
      clearInterval(this.gitPollInterval);
      this.gitPollInterval = undefined;
    }
  }

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
    const trimmed = rawMessage.trim();
    const lower = trimmed.toLowerCase();

    // ── /undo ────────────────────────────────────────────────────────────────
    if (lower === '/undo') {
      if (!this._activeAgentId) {
        this.post({ type: 'error', message: 'No active agent selected.' });
        return;
      }
      const result = await this.undoManager.undo(this._activeAgentId);
      this.post({ type: 'undo_result', message: result });
      return;
    }

    // ── /help ────────────────────────────────────────────────────────────────
    if (lower === '/help') {
      this.post({ type: 'wf_command_result', message: HELP_TEXT });
      return;
    }

    // ── /clear ───────────────────────────────────────────────────────────────
    if (lower === '/clear') {
      this.post({ type: 'wf_command_result', message: '__clear__' });
      return;
    }

    // ── Mode switch slash commands: /ask /plan /code ──────────────────────────
    if (SLASH_MODE_COMMANDS[lower]) {
      const newMode = SLASH_MODE_COMMANDS[lower];
      await this.applyModeChange(newMode, 'slash_command');
      this.post({ type: 'wf_command_result', message: `Switched to ${MODE_LABELS[newMode] ?? newMode} mode.` });
      return;
    }

    // ── /checkpoint ──────────────────────────────────────────────────────────
    if (lower === '/checkpoint') {
      try {
        const cp = await this.runner.checkpoints.createCheckpoint('manual', 'Manual checkpoint from /checkpoint command');
        this.post({ type: 'checkpoint_created', checkpointId: cp.id, label: 'Manual checkpoint', changedFiles: [] });
        void this.auditLogger.logCheckpointEvent('created', cp.id, [], this._activeAgentId ?? 'none');
      } catch (err) {
        this.post({ type: 'error', message: `Checkpoint failed: ${String(err)}` });
      }
      return;
    }

    // ── /resume ──────────────────────────────────────────────────────────────
    if (lower === '/resume') {
      await this.handleResumeCommand();
      return;
    }

    // ── /artifact ────────────────────────────────────────────────────────────
    if (trimmed.startsWith('/artifact')) {
      await this.handleArtifactCommand(trimmed);
      return;
    }

    // ── /wf-* workflow management commands ───────────────────────────────────
    if (trimmed.startsWith('/wf-')) {
      await this.handleWorkflowCommand(trimmed);
      return;
    }

    // ── /ralph-loop ───────────────────────────────────────────────────────────
    if (trimmed.startsWith('/ralph-loop')) {
      await this.handleRalphLoopCommand(trimmed);
      return;
    }

    // ── @agent-name mention ──────────────────────────────────────────────────
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
        async (prompt) => {
          const result = await this.requestInlineAction(prompt, ['Allow', 'Deny']);
          const approved = result === 'Allow';
          void this.auditLogger.logApprovalDecision(
            Math.random().toString(36).slice(2),
            'command',
            approved ? 'approved' : 'denied',
            agentId
          );
          return approved;
        },
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
        },
        // onCompaction
        (droppedCount, preservedItems) => {
          this.post({ type: 'compaction_notice', droppedCount, preservedItems });
        },
        // onPlanCreated
        (plan) => {
          this.post({
            type: 'plan_artifact',
            plan: {
              id: plan.id,
              objective: plan.objective,
              milestones: plan.milestones.map(m => ({
                id: m.id, title: m.title, tasks: m.tasks,
                validations: m.validations, status: m.status,
              })),
              decisions: plan.decisions ?? [],
              blockers: plan.blockers ?? [],
            },
          });
        },
        // onDiffSummary
        (changedFiles, intent, checkpointRef) => {
          this.post({ type: 'diff_summary', changedFiles, intent, checkpointRef });
        },
        // onCheckpointCreated
        (checkpointId, label, changedFiles) => {
          this.post({ type: 'checkpoint_created', checkpointId, label, changedFiles });
          void this.auditLogger.logCheckpointEvent('created', checkpointId, changedFiles, agentId);
        },
        // onContextUpdate
        (items, tokenHealth) => {
          this.post({ type: 'context_update', items, tokenHealth });
        },
        // userMode — pass explicitly selected mode so AgentRunner doesn't auto-override it
        this.currentMode as import('../context/types').AssistantMode,
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
          agent.provider.model = chosen;
          this.currentModel = chosen;
          this.post({ type: 'model_switched', model: chosen });
        }
        break;
      }
      case 'set_mode': {
        const newMode = msg.mode as string;
        if (newMode) {
          await this.applyModeChange(newMode, 'user_picker');
        }
        break;
      }
      case 'restore_checkpoint': {
        const checkpointId = msg.checkpointId as string;
        if (!checkpointId) break;
        try {
          await this.runner.checkpoints.restoreCheckpoint(checkpointId);
          void this.auditLogger.logCheckpointEvent('restored', checkpointId, [], this._activeAgentId ?? 'none');
          this.post({ type: 'wf_command_result', message: `Restored to checkpoint ${checkpointId}.` });
        } catch (err) {
          this.post({ type: 'error', message: `Restore failed: ${String(err)}` });
        }
        break;
      }
      case 'remove_context_item':
        // Acknowledged — item already removed optimistically in the UI.
        // Future: persist exclusion list to workspace state.
        break;
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

    const explicitDefault = !!(agent.useDefaultProvider || !agent.provider?.type);
    let effectiveType = agent.provider.type;
    let effectiveModel = agent.provider.model;
    let usingDefault = false;

    if (explicitDefault) {
      const def = await this.configManager.readDefaultProvider();
      if (def) { effectiveType = def.type; effectiveModel = def.model; }
      usingDefault = true;
    } else {
      const needsOwnKey = authMethodRequiresCredential(agent.provider?.auth_method ?? 'api_key');
      if (needsOwnKey) {
        const ownKey = await this.agentManager.getApiKey(agent.id);
        if (!ownKey) {
          const def = await this.configManager.readDefaultProvider();
          if (def?.type) {
            const defNeedsKey = authMethodRequiresCredential(def.auth_method ?? 'api_key');
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
        effectiveType = defaultProvider?.type ?? a.provider.type;
        effectiveModel = defaultProvider?.model ?? a.provider.model;
        const needsKey = authMethodRequiresCredential(defaultProvider?.auth_method ?? 'api_key');
        configured = !needsKey || (!!defaultProvider && defaultKeySet);
        usesDefault = true;
      } else {
        const needsOwnKey = authMethodRequiresCredential(a.provider?.auth_method ?? 'api_key');
        const ownKey = needsOwnKey ? await this.agentManager.getApiKey(a.id) : 'ok';

        const defaultNeedsKey = authMethodRequiresCredential(defaultProvider?.auth_method ?? 'api_key');
        const hasUsableDefault = !!defaultProvider?.type && (!defaultNeedsKey || defaultKeySet);

        if (!ownKey && needsOwnKey && hasUsableDefault && defaultProvider) {
          effectiveType = defaultProvider.type;
          effectiveModel = defaultProvider.model;
          configured = true;
          usesDefault = true;
        } else {
          effectiveType = a.provider.type;
          effectiveModel = a.provider.model;
          configured = !needsOwnKey || !!ownKey;
          usesDefault = false;
        }
      }

      return { id: a.id, name: a.name, category: a.category, providerType: effectiveType, model: effectiveModel, configured, usesDefault };
    }));

    this.post({ type: 'agent_list', agents, activeAgentId: this._activeAgentId });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  /** Called from the status-bar switchMode command — shows a QuickPick for the three modes. */
  async promptSwitchMode(): Promise<void> {
    const items = [
      { label: '💬 Ask', description: 'Questions only — no file changes', mode: 'ask' },
      { label: '📋 Plan', description: 'Write a plan file for review before coding', mode: 'plan' },
      { label: '⌨️ Code', description: 'Implement immediately (or plan-then-execute for complex tasks)', mode: 'code' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select assistant mode' });
    if (picked) {
      await this.applyModeChange(picked.mode, 'user_picker');
    }
  }

  private async applyModeChange(
    newMode: string,
    source: 'user_picker' | 'slash_command' | 'auto_detect'
  ): Promise<void> {
    const prevMode = this.currentMode;
    this.currentMode = newMode;
    const label = MODE_LABELS[newMode] ?? newMode;
    this.statusBar.updateMode(label);
    this.post({ type: 'mode_changed', mode: newMode, modeLabel: label });
    void this.auditLogger.logModeChanged(this._activeAgentId ?? 'none', prevMode, newMode, source);
  }

  private async handleResumeCommand(): Promise<void> {
    try {
      const root = this.configManager.rootDir;
      const { listPlans, loadPlan } = await import('../context/PlanManager');
      const planIds = listPlans(root);
      if (planIds.length === 0) {
        this.post({ type: 'wf_command_result', message: 'No saved plans found. Start a new task by asking a question or using /plan.' });
        return;
      }
      const plan = loadPlan(root, planIds[0]); // newest first
      if (!plan) {
        this.post({ type: 'wf_command_result', message: 'Could not load the latest plan.' });
        return;
      }

      const pendingMilestone = plan.milestones.find((m: PlanMilestone) => m.status !== 'done' && m.status !== 'blocked');
      const nextAction = pendingMilestone
        ? `Continue with milestone: "${pendingMilestone.title}"`
        : 'All milestones are complete or blocked.';

      this.post({
        type: 'resume_state',
        taskTitle: plan.objective,
        mode: this.currentMode,
        lastSummary: plan.decisions.length > 0 ? plan.decisions[plan.decisions.length - 1] : 'No decisions recorded yet.',
        nextAction,
        selectedFiles: [],
        planId: plan.id,
        blockers: plan.blockers,
      });
    } catch (err) {
      this.post({ type: 'error', message: `Resume failed: ${String(err)}` });
    }
  }

  private async handleRalphLoopCommand(raw: string): Promise<void> {
    const agentId = this._activeAgentId;
    if (!agentId) {
      this.post({ type: 'error', message: 'No agent selected for /ralph-loop. Use @agent-name first.' });
      return;
    }

    // Parse: /ralph-loop "task" --completion-promise "DONE"
    // Supports double-quoted, single-quoted, or unquoted forms.
    let task: string | undefined;
    let completionPromise: string | undefined;
    const dqMatch = raw.match(/^\/ralph-loop\s+"([^"]+)"\s+--completion-promise\s+"([^"]+)"/);
    const sqMatch = !dqMatch && raw.match(/^\/ralph-loop\s+'([^']+)'\s+--completion-promise\s+'([^']+)'/);
    const bareMatch = !dqMatch && !sqMatch && raw.match(/^\/ralph-loop\s+(.+?)\s+--completion-promise\s+(.+)$/s);
    if (dqMatch) {
      [, task, completionPromise] = dqMatch;
    } else if (sqMatch) {
      [, task, completionPromise] = sqMatch;
    } else if (bareMatch) {
      task = bareMatch[1].trim();
      completionPromise = bareMatch[2].trim();
    } else {
      this.post({
        type: 'wf_command_result',
        message: [
          'Usage: /ralph-loop "task description" --completion-promise "DONE"',
          'Example: /ralph-loop "Implement the auth module" --completion-promise "DONE"',
          '',
          'The agent will re-run until its response contains the exact completion-promise string.',
        ].join('\n'),
      });
      return;
    }

    const vsConfig = vscode.workspace.getConfiguration('bormagi');
    // Safety brake only — not a meaningful task limit. Override via bormagi.agent.maxRalphLoopIterations if needed.
    const maxIterations = vsConfig.get<number>('agent.maxRalphLoopIterations', 50);

    const agent = this.agentManager.getAgent(agentId);
    const providerType = agent?.provider.type ?? '';
    const model = agent?.provider.model ?? this.currentModel;

    this.post({
      type: 'wf_command_result',
      message: `Ralph Loop started.\nTask: "${task}"\nCompletion signal: "${completionPromise}"`,
    });

    let iteration = 0;
    let completed = false;

    while (!completed && iteration < maxIterations) {
      iteration++;

      const prompt = iteration === 1
        ? task!
        : [
            `[Continue task: ${task}]`,
            `You have not yet finished. Continue working through any remaining subtasks.`,
            `Do not stop until all work is complete. Only output "${completionPromise}" when every subtask is fully done and verified.`,
          ].join('\n');

      this.post({ type: 'wf_command_result', message: `\n--- Ralph Loop pass ${iteration} ---` });

      let fullResponse = '';

      try {
        await this.runner.run(
          agentId,
          prompt,
          (delta) => {
            fullResponse += delta;
            this.post({ type: 'text_delta', agentId, delta });
          },
          (event) => this.post({ type: 'thought', agentId, event }),
          async (actionPrompt) => {
            const result = await this.requestInlineAction(actionPrompt, ['Allow', 'Deny']);
            const approved = result === 'Allow';
            void this.auditLogger.logApprovalDecision(
              Math.random().toString(36).slice(2),
              'command',
              approved ? 'approved' : 'denied',
              agentId
            );
            return approved;
          },
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
              model,
            });
          },
          (droppedCount, preservedItems) => {
            this.post({ type: 'compaction_notice', droppedCount, preservedItems });
          },
          (plan) => {
            this.post({
              type: 'plan_artifact',
              plan: {
                id: plan.id,
                objective: plan.objective,
                milestones: plan.milestones.map(m => ({
                  id: m.id, title: m.title, tasks: m.tasks,
                  validations: m.validations, status: m.status,
                })),
                decisions: plan.decisions ?? [],
                blockers: plan.blockers ?? [],
              },
            });
          },
          (changedFiles, intent, checkpointRef) => {
            this.post({ type: 'diff_summary', changedFiles, intent, checkpointRef });
          },
          (checkpointId, label, changedFiles) => {
            this.post({ type: 'checkpoint_created', checkpointId, label, changedFiles });
            void this.auditLogger.logCheckpointEvent('created', checkpointId, changedFiles, agentId);
          },
          (items, tokenHealth) => {
            this.post({ type: 'context_update', items, tokenHealth });
          },
          this.currentMode as import('../context/types').AssistantMode,
        );
      } catch (err) {
        this.post({ type: 'error', message: `Ralph Loop iteration ${iteration} error: ${String(err)}` });
        this.post({ type: 'text_done', agentId });
        return;
      }

      this.post({ type: 'text_done', agentId });

      if (fullResponse.includes(completionPromise!)) {
        completed = true;
        this.post({
          type: 'wf_command_result',
          message: `Ralph Loop complete after ${iteration} pass(es). Detected: "${completionPromise}".`,
        });
      } else {
        this.post({
          type: 'wf_command_result',
          message: `Completion signal not yet detected — continuing...`,
        });
      }
    }

    if (!completed) {
      this.post({
        type: 'wf_command_result',
        message: `Ralph Loop safety brake hit (${maxIterations} passes) without detecting "${completionPromise}". Increase bormagi.agent.maxRalphLoopIterations if the task needs more passes.`,
      });
    }
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

  // ─── WF commands ────────────────────────────────────────────────────────────

  private async handleWorkflowCommand(raw: string): Promise<void> {
    if (!this.workflowEngine || !this.workflowStorage) {
      this.post({
        type: 'wf_command_result',
        message: '⚠ Workflow engine is not available in this session. Ensure a workspace with a `.bormagi/workflows/` directory is open.'
      });
      return;
    }

    const parts = raw.split(/\s+/);
    const subcommand = parts[0].slice(4);

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

    const confirmed = await this.requestInlineAction(
      `Resume task "${taskId}" in workflow "${workflowId}"?`,
      ['Resume', 'Cancel']
    );
    if (confirmed !== 'Resume') return;

    try {
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

    const finalReason = reason?.trim();
    if (!finalReason) {
      this.post({ type: 'wf_command_result', message: `Please include a reason: /wf-cancel ${taskId} <reason>` });
      return;
    }

    const confirmed = await this.requestInlineAction(
      `Cancel task "${taskId}"? This cannot be undone.\nReason: ${finalReason}`,
      ['Cancel Task', 'Abort']
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

    const confirmed = await this.requestInlineAction(
      `Reassign task "${taskId}" to agent "${newAgent.name}"?`,
      ['Reassign', 'Cancel']
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

  // ─── Workflow command helpers ────────────────────────────────────────────────

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

  private async resolveWorkflowIdForTask(taskId: string): Promise<string | undefined> {
    const ids = await this.workflowStorage!.listWorkflowIds();
    for (const id of ids) {
      const tasks = await this.workflowStorage!.loadTasks(id);
      if (tasks.some(t => t.id === taskId)) return id;
    }
    return undefined;
  }

  private estimateCost(model: string, totalInputTokens: number, totalOutputTokens: number): number {
    const p = getAppData().pricing[model];
    if (!p) return 0;
    return (totalInputTokens / 1e6) * p.in + (totalOutputTokens / 1e6) * p.out;
  }

  /** Post an inline action card to the webview and await the user's choice. */
  private requestInlineAction(prompt: string, actions: string[]): Promise<string | undefined> {
    const id = Math.random().toString(36).slice(2);
    return new Promise(resolve => {
      this._pendingActions.set(id, resolve);
      this.post({ type: 'action_request', id, prompt, actions });
    });
  }

  /** Called by ChatViewProvider when the webview posts an action_response. */
  resolveAction(id: string, value: string | undefined): void {
    const resolver = this._pendingActions.get(id);
    if (resolver) {
      this._pendingActions.delete(id);
      resolver(value);
    }
  }

  private post(msg: MessageToWebview): void {
    this._subscribers.forEach(cb => { try { cb(msg); } catch { /* disposed */ } });
  }
}
