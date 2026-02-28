import * as vscode from 'vscode';
import * as path from 'path';
import { AgentManager } from '../agents/AgentManager';
import { AgentRunner } from '../agents/AgentRunner';
import { PromptComposer } from '../agents/PromptComposer';
import { MemoryManager } from '../agents/MemoryManager';
import { UndoManager } from '../agents/UndoManager';
import { SkillManager } from '../skills/SkillManager';
import { MCPHost } from '../mcp/MCPHost';
import { AuditLogger } from '../audit/AuditLogger';
import { ConfigManager } from '../config/ConfigManager';
import { DiffManager } from '../ui/DiffManager';
import { ApprovalDialog } from '../ui/ApprovalDialog';
import { StatusBar } from '../ui/StatusBar';
import { ProviderType, ThoughtEvent } from '../types';

// Models available per provider (mirrors AgentSettingsPanel)
const PROVIDER_MODELS: Record<ProviderType, string[]> = {
  openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4.5-preview', 'o1-preview', 'o1-mini', 'o3-mini'],
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  gemini:    ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  deepseek:  ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
  qwen:      ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-coder-turbo']
};

export type MessageToWebview =
  | { type: 'text_delta'; agentId: string; delta: string }
  | { type: 'text_done'; agentId: string }
  | { type: 'thought'; agentId: string; event: ThoughtEvent }
  | { type: 'error'; message: string }
  | { type: 'agent_changed'; agentId: string; agentName: string; providerType: string; model: string; usingDefault: boolean }
  | { type: 'agent_list'; agents: { id: string; name: string; category: string; providerType: string; model: string }[]; activeAgentId?: string }
  | { type: 'undo_result'; message: string }
  | { type: 'token_usage'; lastInputTokens: number; lastOutputTokens: number; sessionInputTokens: number; sessionOutputTokens: number; model: string }
  | { type: 'model_switched'; model: string };

export class ChatController {
  private _activeAgentId: string | undefined;
  private runner: AgentRunner;
  private memoryManager: MemoryManager;
  private undoManager: UndoManager;
  private skillManager: SkillManager;
  private diffManager = new DiffManager();
  private approvalDialog = new ApprovalDialog();
  private webviewPostMessage?: (msg: MessageToWebview) => void;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private currentModel = '';

  constructor(
    private readonly agentManager: AgentManager,
    private readonly mcpHost: MCPHost,
    private readonly configManager: ConfigManager,
    private readonly auditLogger: AuditLogger,
    private readonly statusBar: StatusBar,
    workspaceRoot: string
  ) {
    this.memoryManager = new MemoryManager(configManager);
    this.undoManager = new UndoManager();
    this.skillManager = new SkillManager(configManager);

    const promptComposer = new PromptComposer(configManager);

    this.runner = new AgentRunner(
      agentManager,
      mcpHost,
      promptComposer,
      this.memoryManager,
      this.undoManager,
      this.skillManager,
      auditLogger,
      configManager,
      workspaceRoot
    );
  }

  get activeAgentName(): string | undefined {
    if (!this._activeAgentId) {
      return undefined;
    }
    return this.agentManager.getAgent(this._activeAgentId)?.name;
  }

  registerWebviewCallback(cb: (msg: MessageToWebview) => void): void {
    this.webviewPostMessage = cb;
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

    // Load skills before running
    await this.skillManager.loadAll();

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
        const models = PROVIDER_MODELS[agent.provider.type as ProviderType] ?? [];
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
    this.currentModel = agent.provider.model;
    // Reset session token counters when switching agents
    this.sessionInputTokens = 0;
    this.sessionOutputTokens = 0;
    this.statusBar.update(agent.name);
    await this.auditLogger.logAgentSwitch(agentId);
    const usingDefault = !!(agent.useDefaultProvider || !agent.provider?.type);
    this.post({
      type: 'agent_changed',
      agentId,
      agentName: agent.name,
      providerType: agent.provider.type,
      model: agent.provider.model,
      usingDefault
    });
  }

  async refreshAgentList(): Promise<void> {
    await this.agentManager.loadAgents();
    const agents = this.agentManager.listAgents().map(a => ({
      id: a.id,
      name: a.name,
      category: a.category,
      providerType: a.provider.type,
      model: a.provider.model
    }));
    this.post({ type: 'agent_list', agents, activeAgentId: this._activeAgentId });
  }

  private async handleArtifactCommand(raw: string): Promise<void> {
    const ARTIFACT_TYPES = ['adr', 'pr-description', 'design-doc', 'task-breakdown', 'test-plan'];
    const parts = raw.split(/\s+/);
    let artifactType = parts[1];

    if (!artifactType || !ARTIFACT_TYPES.includes(artifactType)) {
      artifactType = await vscode.window.showQuickPick(ARTIFACT_TYPES, {
        title: 'Extract artifact from conversation',
        placeHolder: 'Choose artifact type'
      }) ?? '';
      if (!artifactType) {
        return;
      }
    }

    const PROMPTS: Record<string, string> = {
      'adr': 'Based on our conversation above, write an Architecture Decision Record with the standard sections: Title, Status, Context, Decision, and Consequences.',
      'pr-description': 'Based on our conversation above, write a pull request description with: Summary (3 bullets), Type of Change checkboxes, Testing steps, and a Checklist.',
      'design-doc': 'Based on our conversation above, write a technical design document with sections: Overview, Goals, Architecture, Implementation Plan, and Risks.',
      'task-breakdown': 'Based on our conversation above, produce a numbered task breakdown. For each task include: description, effort estimate (S/M/L), and dependencies.',
      'test-plan': 'Based on our conversation above, write a test plan covering: scope, test cases with expected results, edge cases, and acceptance criteria.'
    };

    await this.handleUserMessage(`[Artifact extraction — ${artifactType}]\n${PROMPTS[artifactType]}`);
  }

  private estimateCost(model: string, totalInputTokens: number, totalOutputTokens: number): number {
    // USD per 1M tokens
    const PRICING: Record<string, { in: number; out: number }> = {
      'gpt-4o':                    { in: 5.00,  out: 15.00 },
      'gpt-4o-mini':               { in: 0.15,  out: 0.60  },
      'gpt-4-turbo':               { in: 10.00, out: 30.00 },
      'gpt-4.5-preview':           { in: 75.00, out: 150.00 },
      'o1-preview':                { in: 15.00, out: 60.00 },
      'o1-mini':                   { in: 1.10,  out: 4.40  },
      'o3-mini':                   { in: 1.10,  out: 4.40  },
      'claude-opus-4-6':           { in: 15.00, out: 75.00 },
      'claude-sonnet-4-6':         { in: 3.00,  out: 15.00 },
      'claude-haiku-4-5-20251001': { in: 0.80,  out: 4.00  },
      'gemini-2.0-flash':          { in: 0.10,  out: 0.40  },
      'gemini-1.5-pro':            { in: 3.50,  out: 10.50 },
      'gemini-1.5-flash':          { in: 0.075, out: 0.30  },
      'deepseek-chat':             { in: 0.27,  out: 1.10  },
      'deepseek-coder':            { in: 0.27,  out: 1.10  },
      'deepseek-reasoner':         { in: 0.55,  out: 2.19  },
      'qwen-max':                  { in: 0.80,  out: 2.40  },
      'qwen-plus':                 { in: 0.30,  out: 0.90  },
      'qwen-turbo':                { in: 0.05,  out: 0.20  },
      'qwen-coder-turbo':          { in: 0.30,  out: 0.90  }
    };
    const p = PRICING[model];
    if (!p) return 0;
    return (totalInputTokens / 1e6) * p.in + (totalOutputTokens / 1e6) * p.out;
  }

  private post(msg: MessageToWebview): void {
    this.webviewPostMessage?.(msg);
  }

  // Needed so ChatViewProvider can forward messages from the webview
  get path(): typeof path { return path; }
}
