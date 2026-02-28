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
  ThoughtEvent,
  TokenUsage
} from '../types';
import type { AgentExecutionResult } from '../workflow/types';
import { ExecutionOutcome } from '../workflow/enums';

export type ThoughtCallback = (event: ThoughtEvent) => void;
export type TextCallback = (delta: string) => void;
export type ApprovalCallback = (prompt: string) => Promise<boolean>;
export type DiffCallback = (filePath: string, originalContent: string, newContent: string) => Promise<boolean>;
export type TokenUsageCallback = (usage: TokenUsage) => void;

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

  // ─── Secret patterns scanned before each LLM call ─────────────────────────
  private static readonly SECRET_PATTERNS = [
    /sk-[A-Za-z0-9]{32,}/,
    /AIza[A-Za-z0-9\-_]{35}/,
    /ghp_[A-Za-z0-9]{36}/,
    /xox[baprs]-[0-9A-Za-z\-]+/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  ];

  async run(
    agentId: string,
    userMessage: string,
    onText: TextCallback,
    onThought: ThoughtCallback,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    onTokenUsage?: TokenUsageCallback
  ): Promise<void> {
    const agentConfig = this.agentManager.getAgent(agentId);
    if (!agentConfig) {
      onText(`Agent "${agentId}" not found.`);
      return;
    }

    // Resolve effective provider — fall back to workspace default if not configured
    let effectiveProvider = agentConfig.provider;
    let apiKeyId = agentId;
    if (agentConfig.useDefaultProvider || !agentConfig.provider?.type) {
      const def = await this.configManager.readDefaultProvider();
      if (!def?.type) {
        onText('No provider configured for this agent and no workspace default set.\nOpen Agent Settings → Default Provider to configure one.');
        return;
      }
      effectiveProvider = def;
      apiKeyId = '__default__';
    }

    const apiKey = await this.agentManager.getApiKey(apiKeyId);
    if (!apiKey && effectiveProvider.auth_method === 'api_key') {
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

    // Assemble message history (loads persisted Memory.md on first call for this agent)
    const sessionHistory = await this.memoryManager.getSessionHistoryWithMemory(agentId);
    const messages: ChatMessage[] = [
      { role: 'system', content: fullSystem },
      ...sessionHistory
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

    // Gather available tools — inject virtual tools not backed by MCP servers
    const virtualTools: MCPToolDefinition[] = [{
      name: 'get_diagnostics',
      description: 'Read VS Code diagnostics (Problems panel) for a file or the entire workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative file path to filter diagnostics.' }
        }
      }
    }];
    const tools = [...this.mcpHost.getAllTools(), ...virtualTools];

    // Scan for secrets before sending context to the LLM
    const blob = messages.map(m => m.content).join('\n');
    const secretHits = AgentRunner.SECRET_PATTERNS.filter(p => p.test(blob));
    if (secretHits.length > 0) {
      onThought({
        type: 'error',
        label: `⚠ ${secretHits.length} potential secret(s) detected in context`,
        detail: 'Sensitive patterns (API keys, tokens, private keys) found in the context being sent to the LLM. Review and remove them if unintended.',
        timestamp: new Date()
      });
    }

    // Create LLM provider using the resolved (possibly default) provider config
    const providerConfig = { ...agentConfig, provider: effectiveProvider };
    const provider = ProviderFactory.create(providerConfig, apiKey);

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
          () => { continueLoop = pendingToolCall !== null; },
          onTokenUsage
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
    _tools: MCPToolDefinition[],
    onText: TextCallback,
    onThought: ThoughtCallback,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    toolsUsed: string[],
    accumulateText: (t: string) => void,
    setPendingTool: (tc: { id: string; name: string; input: Record<string, unknown> }) => void,
    signalContinue: () => void,
    onTokenUsage?: TokenUsageCallback
  ): Promise<void> {
    if (event.type === 'token_usage') {
      onTokenUsage?.(event.usage);
    } else if (event.type === 'text') {
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
      const APPROVAL_TOOLS = ['run_command', 'git_commit', 'git_push', 'git_create_pr', 'gcp_deploy'];
      let approved = true;
      if (APPROVAL_TOOLS.includes(event.name)) {
        const detail = (event.input as { command?: string; message?: string; title?: string }).command
          ?? (event.input as { command?: string; message?: string; title?: string }).message
          ?? (event.input as { command?: string; message?: string; title?: string }).title
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
      } else if (event.name === 'get_diagnostics') {
        toolResultText = this.handleGetDiagnostics(event.input as { path?: string });
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

    // Read existing content for undo — track whether the file existed to distinguish
    // an empty file ('') from a brand-new file (so undo restores correctly in both cases)
    let originalContent = '';
    let fileExisted = false;
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      originalContent = Buffer.from(raw).toString('utf8');
      fileExisted = true;
    } catch {
      fileExisted = false; // File does not yet exist
    }

    // Show diff and request approval
    const approved = await onDiff(filePath, originalContent, args.content);

    if (!approved) {
      return 'User declined the file change.';
    }

    // Record undo state before writing
    this.undoManager.recordFileWrite(agentId, filePath, originalContent, fileExisted);

    // Apply the write via the filesystem MCP server
    const serverName = 'filesystem';
    const result = await this.mcpHost.callTool(serverName, {
      name: 'write_file',
      input: { path: args.path, content: args.content }
    });

    await this.auditLogger.logFileWrite(filePath, agentId);
    return result.content.map(c => c.text).join('\n');
  }

  private handleGetDiagnostics(args: { path?: string }): string {
    const SEVERITY = ['Error', 'Warning', 'Info', 'Hint'];
    const lines: string[] = [];

    if (args.path) {
      const uri = vscode.Uri.file(path.join(this.workspaceRoot, args.path));
      const diags = vscode.languages.getDiagnostics(uri);
      for (const d of diags) {
        lines.push(`${args.path} [${SEVERITY[d.severity] ?? d.severity}] ${d.message} (L${d.range.start.line + 1})`);
      }
    } else {
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        const rel = path.relative(this.workspaceRoot, uri.fsPath);
        for (const d of diags) {
          lines.push(`${rel} [${SEVERITY[d.severity] ?? d.severity}] ${d.message} (L${d.range.start.line + 1})`);
        }
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'No diagnostics found.';
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
      git_create_branch: 'git',
      git_push: 'git',
      git_create_pr: 'git',
      gcp_auth_status: 'gcp',
      gcp_deploy: 'gcp'
    };
    return serverMap[toolName];
  }

  // ─── WF-202: Structured completion payload parsing ───────────────────────────

  /**
   * Run the agent and return a typed AgentExecutionResult for workflow orchestration.
   *
   * The agent may signal a structured outcome by including a JSON fence in its
   * response that begins with `"__bormagi_outcome__": true`. Example:
   *
   * ```json
   * {
   *   "__bormagi_outcome__": true,
   *   "outcome": "delegate",
   *   "summary": "Completed requirements; handing off to architect.",
   *   "toAgentId": "solution-architect",
   *   "objective": "Design the system based on the approved requirements.",
   *   "reasonForHandoff": "Requirements are complete and approved.",
   *   "constraints": [],
   *   "expectedOutputs": ["Architecture diagram", "ADR"],
   *   "doneCriteria": ["All components defined", "ADRs written"]
   * }
   * ```
   *
   * Agents that do not produce a structured payload are treated as `completed`.
   */
  async runWithWorkflow(
    agentId: string,
    taskId: string,
    workflowId: string,
    userMessage: string,
    onText: TextCallback,
    onThought: ThoughtCallback,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    onTokenUsage?: TokenUsageCallback
  ): Promise<AgentExecutionResult> {
    let fullResponse = '';

    // Capture the full response via the onText callback
    const capturingOnText: TextCallback = (delta) => {
      fullResponse += delta;
      onText(delta);
    };

    await this.run(agentId, userMessage, capturingOnText, onThought, onApproval, onDiff, onTokenUsage);

    const completedAt = new Date().toISOString();
    const parsed = this.parseStructuredCompletion(fullResponse);

    if (parsed) {
      onThought({
        type: 'thinking',
        label: `Structured outcome: ${parsed.outcome}`,
        detail: JSON.stringify({ outcome: parsed.outcome, summary: parsed.summary }, null, 2),
        timestamp: new Date(),
      });
      return { ...parsed, taskId, workflowId, agentId, completedAt };
    }

    // No structured payload — treat as plain completion
    return {
      taskId,
      workflowId,
      agentId,
      outcome: ExecutionOutcome.Completed,
      summary: fullResponse.slice(0, 500),
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
      completedAt,
    };
  }

  /**
   * Parse a structured completion payload from the agent's full text response.
   * Scans for a JSON fence containing `"__bormagi_outcome__": true`.
   * Returns null if no valid structured payload is found.
   * Never throws — invalid JSON is silently ignored and treated as plain completion.
   */
  parseStructuredCompletion(
    responseText: string
  ): Omit<AgentExecutionResult, 'taskId' | 'workflowId' | 'agentId' | 'completedAt'> | null {
    // Match any ```json ... ``` fence that contains __bormagi_outcome__
    const fencePattern = /```(?:json)?\s*(\{[\s\S]*?"__bormagi_outcome__"\s*:\s*true[\s\S]*?\})\s*```/;
    const match = responseText.match(fencePattern);
    if (!match) {
      return null;
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(match[1]) as Record<string, unknown>;
    } catch {
      return null;  // Malformed JSON — fall back to plain completion
    }

    const outcome = raw['outcome'] as string;
    const validOutcomes: string[] = Object.values(ExecutionOutcome);
    if (!validOutcomes.includes(outcome)) {
      return null;  // Unknown outcome value — reject gracefully
    }

    const result: Omit<AgentExecutionResult, 'taskId' | 'workflowId' | 'agentId' | 'completedAt'> = {
      outcome: outcome as AgentExecutionResult['outcome'],
      summary: (raw['summary'] as string | undefined) ?? '',
      producedArtifactIds: (raw['producedArtifactIds'] as string[] | undefined) ?? [],
      delegateTo: (raw['toAgentId'] as string | undefined) ?? null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
    };

    // Populate outcome-specific fields
    if (outcome === ExecutionOutcome.Delegated && raw['toAgentId']) {
      result.handoffRequest = {
        workflowId: '',  // Filled in by the engine
        taskId: '',
        parentTaskId: null,
        stageId: '',
        fromAgentId: '',
        toAgentId: raw['toAgentId'] as string,
        returnToAgentId: null,
        objective: (raw['objective'] as string | undefined) ?? result.summary,
        reasonForHandoff: (raw['reasonForHandoff'] as string | undefined) ?? '',
        inputArtifactIds: (raw['inputArtifactIds'] as string[] | undefined) ?? [],
        relevantDecisionIds: (raw['relevantDecisionIds'] as string[] | undefined) ?? [],
        constraints: (raw['constraints'] as string[] | undefined) ?? [],
        expectedOutputs: (raw['expectedOutputs'] as string[] | undefined) ?? [],
        doneCriteria: (raw['doneCriteria'] as string[] | undefined) ?? [],
        isBlocking: (raw['isBlocking'] as boolean | undefined) ?? true,
      };
    }

    if (outcome === ExecutionOutcome.ReviewRequested && raw['reviewerAgentId']) {
      result.reviewRequest = {
        workflowId: '',
        taskId: '',
        requestingAgentId: '',
        reviewerAgentId: raw['reviewerAgentId'] as string,
        itemUnderReview: (raw['itemUnderReview'] as string | undefined) ?? result.summary,
        reviewScope: (raw['reviewScope'] as string | undefined) ?? '',
        reviewCriteria: (raw['reviewCriteria'] as string[] | undefined) ?? [],
        isBlocking: (raw['isBlocking'] as boolean | undefined) ?? true,
      };
    }

    if (outcome === ExecutionOutcome.Blocked && raw['reason']) {
      result.blocker = {
        workflowId: '',
        stageId: '',
        taskId: '',
        raisedByAgentId: '',
        reason: raw['reason'] as string,
        severity: (raw['severity'] as AgentExecutionResult['blocker'] extends null ? never : NonNullable<AgentExecutionResult['blocker']>['severity']) ?? 'medium',
        suggestedRoute: (raw['suggestedRoute'] as string | undefined) ?? '',
      };
    }

    return result;
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
