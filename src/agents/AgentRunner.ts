import * as vscode from 'vscode';
import * as path from 'path';
import { AgentManager } from './AgentManager';
import { PromptComposer } from './PromptComposer';
import { MemoryManager } from './MemoryManager';
import { UndoManager } from './UndoManager';
import { SkillManager } from '../skills/SkillManager';
import { MCPHost } from '../mcp/MCPHost';
import { AuditLogger } from '../audit/AuditLogger';
import { ProviderFactory } from '../providers/ProviderFactory';
import { FileScanner } from '../utils/FileScanner';
import { ConfigManager } from '../config/ConfigManager';
import {
  ChatMessage,
  MCPToolDefinition,
  MCPToolCall,
  StreamEvent,
  ThoughtEvent
} from '../types';

export type ThoughtCallback = (event: ThoughtEvent) => void;
export type TextCallback = (delta: string) => void;
export type ApprovalCallback = (prompt: string) => Promise<boolean>;
export type DiffCallback = (filePath: string, originalContent: string, newContent: string) => Promise<boolean>;

export class AgentRunner {
  constructor(
    private readonly agentManager: AgentManager,
    private readonly mcpHost: MCPHost,
    private readonly promptComposer: PromptComposer,
    private readonly memoryManager: MemoryManager,
    private readonly undoManager: UndoManager,
    private readonly skillManager: SkillManager,
    private readonly auditLogger: AuditLogger,
    private readonly configManager: ConfigManager,
    private readonly workspaceRoot: string
  ) {}

  async run(
    agentId: string,
    userMessage: string,
    onText: TextCallback,
    onThought: ThoughtCallback,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback
  ): Promise<void> {
    const agentConfig = this.agentManager.getAgent(agentId);
    if (!agentConfig) {
      onText(`Agent "${agentId}" not found.`);
      return;
    }

    const apiKey = await this.agentManager.getApiKey(agentId);
    if (!apiKey && agentConfig.provider.auth_method === 'api_key') {
      onText('API key not configured. Open Agent Settings to add your API key.');
      return;
    }

    // Ensure MCP servers are running for this agent
    await this.agentManager.startMCPServersForAgent(agentId, this.workspaceRoot);

    // Build system prompt
    const projectConfig = await this.configManager.readProjectConfig();
    const projectName = projectConfig?.project.name ?? '';
    const systemPrompt = await this.promptComposer.compose(agentConfig, projectName);
    const skillsSection = this.skillManager.buildSkillsPromptSection();
    const fullSystem = skillsSection
      ? `${systemPrompt}\n\n${skillsSection}`
      : systemPrompt;

    // Build workspace context summary
    const contextSummary = await this.buildContextSummary(agentConfig);

    // Assemble message history
    const messages: ChatMessage[] = [
      { role: 'system', content: fullSystem },
      ...this.memoryManager.getSessionHistory(agentId)
    ];

    // Include context as a system message after history
    if (contextSummary) {
      messages.push({
        role: 'user',
        content: `[Workspace context]\n${contextSummary}`
      });
      messages.push({
        role: 'assistant',
        content: 'I have reviewed the workspace context. How can I help you?'
      });
    }

    // Add the user's message
    const userMsg: ChatMessage = { role: 'user', content: userMessage };
    messages.push(userMsg);
    this.memoryManager.addMessage(agentId, userMsg);

    // Gather available tools
    const tools = this.mcpHost.getAllTools();

    // Create LLM provider and run the agentic loop
    const provider = ProviderFactory.create(agentConfig, apiKey);

    let fullResponse = '';
    const toolsUsed: string[] = [];
    let continueLoop = true;

    while (continueLoop) {
      continueLoop = false;
      let pendingToolCall: { id: string; name: string; input: Record<string, unknown> } | null = null;

      for await (const event of provider.stream(messages, tools)) {
        await this.handleStreamEvent(
          event,
          agentId,
          agentConfig.id,
          messages,
          tools,
          onText,
          onThought,
          onApproval,
          onDiff,
          toolsUsed,
          (text) => { fullResponse += text; },
          (tc) => { pendingToolCall = tc; },
          () => { continueLoop = pendingToolCall !== null; }
        );
      }
    }

    // Persist turn to memory
    if (fullResponse) {
      const assistantMsg: ChatMessage = { role: 'assistant', content: fullResponse };
      this.memoryManager.addMessage(agentId, assistantMsg);
      await this.memoryManager.persistTurn(agentId, userMessage, fullResponse, toolsUsed);
    }
  }

  private async handleStreamEvent(
    event: StreamEvent,
    agentId: string,
    _agentConfigId: string,
    messages: ChatMessage[],
    tools: MCPToolDefinition[],
    onText: TextCallback,
    onThought: ThoughtCallback,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    toolsUsed: string[],
    accumulateText: (t: string) => void,
    setPendingTool: (tc: { id: string; name: string; input: Record<string, unknown> }) => void,
    signalContinue: () => void
  ): Promise<void> {
    if (event.type === 'text') {
      onText(event.delta);
      accumulateText(event.delta);
    } else if (event.type === 'tool_use') {
      const tc: MCPToolCall = { name: event.name, input: event.input };
      toolsUsed.push(event.name);

      onThought({
        type: 'tool_call',
        label: `Tool: ${event.name}`,
        detail: JSON.stringify(event.input, null, 2),
        timestamp: new Date()
      });

      // Approval gate for sensitive tools
      let approved = true;
      if (event.name === 'run_command' || event.name === 'git_commit' || event.name === 'gcp_deploy') {
        const detail = (event.input as { command?: string; message?: string }).command
          ?? (event.input as { command?: string; message?: string }).message
          ?? JSON.stringify(event.input);
        approved = await onApproval(`Agent wants to run:\n\n${detail}\n\nAllow?`);
        await this.auditLogger.logCommand(detail, agentId, approved);
      }

      let toolResultText = '';

      if (!approved) {
        toolResultText = 'User denied this action.';
      } else if (event.name === 'write_file') {
        toolResultText = await this.handleWriteFile(
          agentId,
          event.input as { path: string; content: string },
          onDiff
        );
      } else {
        // Determine which server owns this tool
        const serverName = this.findServerForTool(event.name);
        if (serverName) {
          const result = await this.mcpHost.callTool(serverName, tc);
          toolResultText = result.content.map(c => c.text).join('\n');
        } else {
          toolResultText = `Tool "${event.name}" not found in any running MCP server.`;
        }
      }

      onThought({
        type: 'tool_result',
        label: `Result: ${event.name}`,
        detail: toolResultText.slice(0, 500),
        timestamp: new Date()
      });

      // Feed tool result back to conversation and signal another LLM pass
      messages.push({
        role: 'user',
        content: `[Tool result: ${event.name}]\n${toolResultText}`
      });
      setPendingTool(event);
      signalContinue();
    }
  }

  private async handleWriteFile(
    agentId: string,
    args: { path: string; content: string },
    onDiff: DiffCallback
  ): Promise<string> {
    const filePath = path.join(this.workspaceRoot, args.path);

    // Read existing content for undo
    let originalContent = '';
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      originalContent = Buffer.from(raw).toString('utf8');
    } catch {
      originalContent = ''; // New file
    }

    // Show diff and request approval
    const approved = await onDiff(filePath, originalContent, args.content);

    if (!approved) {
      return 'User declined the file change.';
    }

    // Record undo state before writing
    this.undoManager.recordFileWrite(agentId, filePath, originalContent || undefined!);

    // Apply the write via the filesystem MCP server
    const serverName = 'filesystem';
    const result = await this.mcpHost.callTool(serverName, {
      name: 'write_file',
      input: { path: args.path, content: args.content }
    });

    await this.auditLogger.logFileWrite(filePath, agentId);
    return result.content.map(c => c.text).join('\n');
  }

  private findServerForTool(toolName: string): string | undefined {
    const serverMap: Record<string, string> = {
      read_file: 'filesystem',
      write_file: 'filesystem',
      list_files: 'filesystem',
      search_files: 'filesystem',
      run_command: 'terminal',
      git_status: 'git',
      git_diff: 'git',
      git_commit: 'git',
      git_log: 'git',
      gcp_auth_status: 'gcp',
      gcp_deploy: 'gcp'
    };
    return serverMap[toolName];
  }

  private async buildContextSummary(agentConfig: { context_filter: { include_extensions: string[]; exclude_patterns: string[] } }): Promise<string> {
    try {
      const vsConfig = vscode.workspace.getConfiguration('bormagi');
      const maxFiles = vsConfig.get<number>('contextMaxFiles', 50);
      const maxFileSizeKb = vsConfig.get<number>('contextMaxFileSizeKb', 100);

      const scanner = new FileScanner(this.workspaceRoot);
      const files = await scanner.scanWorkspace(
        new Set(agentConfig.context_filter.include_extensions),
        agentConfig.context_filter.exclude_patterns,
        maxFiles,
        maxFileSizeKb
      );

      if (files.length === 0) {
        return '';
      }

      const parts = files.map(f =>
        `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``
      );
      return parts.join('\n\n');
    } catch {
      return '';
    }
  }
}
