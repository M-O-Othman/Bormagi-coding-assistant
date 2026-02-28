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
import { ThoughtEvent } from '../types';

export type MessageToWebview =
  | { type: 'text_delta'; agentId: string; delta: string }
  | { type: 'text_done'; agentId: string }
  | { type: 'thought'; agentId: string; event: ThoughtEvent }
  | { type: 'error'; message: string }
  | { type: 'agent_changed'; agentId: string; agentName: string; providerType: string; model: string }
  | { type: 'agent_list'; agents: { id: string; name: string; category: string; providerType: string; model: string }[]; activeAgentId?: string }
  | { type: 'undo_result'; message: string };

export class ChatController {
  private _activeAgentId: string | undefined;
  private runner: AgentRunner;
  private memoryManager: MemoryManager;
  private undoManager: UndoManager;
  private skillManager: SkillManager;
  private diffManager = new DiffManager();
  private approvalDialog = new ApprovalDialog();
  private webviewPostMessage?: (msg: MessageToWebview) => void;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly configManager: ConfigManager,
    private readonly auditLogger: AuditLogger,
    private readonly statusBar: StatusBar
  ) {
    this.memoryManager = new MemoryManager(configManager);
    this.undoManager = new UndoManager();
    this.skillManager = new SkillManager(configManager);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    const mcpHost: MCPHost = (agentManager as unknown as { mcpHost?: MCPHost }).mcpHost
      ?? new (require('../mcp/MCPHost').MCPHost)(
        vscode.extensions.getExtension('bormagi.bormagi')?.extensionPath ?? '',
        auditLogger
      ) as MCPHost;

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

    try {
      await this.runner.run(
        agentId,
        rawMessage,
        (delta) => this.post({ type: 'text_delta', agentId, delta }),
        (event) => this.post({ type: 'thought', agentId, event }),
        async (prompt) => this.approvalDialog.request(prompt),
        async (filePath, original, proposed) =>
          this.diffManager.showAndApprove(filePath, original, proposed)
      );
    } catch (err) {
      this.post({ type: 'error', message: String(err) });
    } finally {
      this.post({ type: 'text_done', agentId });
    }
  }

  async setActiveAgent(agentId: string): Promise<void> {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      return;
    }
    this._activeAgentId = agentId;
    this.statusBar.update(agent.name);
    await this.auditLogger.logAgentSwitch(agentId);
    this.post({
      type: 'agent_changed',
      agentId,
      agentName: agent.name,
      providerType: agent.provider.type,
      model: agent.provider.model
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

  private post(msg: MessageToWebview): void {
    this.webviewPostMessage?.(msg);
  }
}
