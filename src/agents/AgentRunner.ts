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
import { generateDocx, generatePptx } from '../utils/DocumentGenerator';
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

  // ─── Model context limits (tokens) ────────────────────────────────────────
  private static readonly MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'gpt-4o':                    128_000,
    'gpt-4o-mini':               128_000,
    'gpt-4-turbo':               128_000,
    'gpt-4.5-preview':           128_000,
    'o1-preview':                128_000,
    'o1-mini':                   128_000,
    'o3-mini':                   200_000,
    'claude-opus-4-6':           200_000,
    'claude-sonnet-4-6':         200_000,
    'claude-haiku-4-5-20251001': 200_000,
    'gemini-2.0-flash':          1_048_576,
    'gemini-1.5-pro':            2_097_152,
    'gemini-1.5-flash':          1_048_576,
    'deepseek-chat':              65_536,
    'deepseek-coder':             65_536,
    'deepseek-reasoner':          65_536,
    'qwen-max':                   32_768,
    'qwen-plus':                 131_072,
    'qwen-turbo':                131_072,
    'qwen-coder-turbo':          131_072,
  };

  /** Character-based token estimate: ~4 chars/token. Conservative for code/prose. */
  private static estimateTokenCount(messages: ChatMessage[]): number {
    const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    return Math.ceil(chars / 4);
  }

  // ─── Secret patterns scanned before each LLM call ─────────────────────────
  private static readonly SECRET_PATTERNS = [
    /sk-[A-Za-z0-9]{32,}/,
    /AIza[A-Za-z0-9\-_]{35}/,
    /ghp_[A-Za-z0-9]{36}/,
    /xox[baprs]-[0-9A-Za-z\-]+/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  ];

  // ─── NF2-AI-002: Prompt injection patterns ─────────────────────────────────
  // Patterns that indicate an agent is trying to override instructions.
  // Matched case-insensitively against individual lines within text fields.
  private static readonly INJECTION_PATTERNS: RegExp[] = [
    /^\s*ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context)/i,
    /^\s*disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context)/i,
    /^\s*forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context)/i,
    /^\s*new\s+(system\s+)?instructions?\s*:/i,
    /^\s*system\s*:\s*(you\s+(are|must)|ignore|override)/i,
    /^\s*\[system\]/i,
    /^\s*\[override\]/i,
    /^\s*act\s+as\s+(if\s+you\s+are|a\s+different)/i,
    /^\s*you\s+are\s+now\s+(a|an)\s+/i,
  ];

  /**
   * Sanitise a single text field from a structured completion payload.
   * Strips any line that matches a known prompt injection pattern.
   * Returns { clean, hadInjection }.
   */
  private static sanitiseStructuredField(text: string): { clean: string; hadInjection: boolean } {
    const lines = text.split('\n');
    let hadInjection = false;
    const cleaned = lines.filter(line => {
      const isInjection = AgentRunner.INJECTION_PATTERNS.some(p => p.test(line));
      if (isInjection) { hadInjection = true; }
      return !isInjection;
    });
    return { clean: cleaned.join('\n').trim(), hadInjection };
  }

  /**
   * Sanitise all user-visible text fields of a parsed execution result.
   * Returns the cleaned result and the names of any fields that contained
   * injection patterns.
   */
  private sanitiseExecutionResult(
    parsed: Omit<AgentExecutionResult, 'taskId' | 'workflowId' | 'agentId' | 'completedAt'>
  ): { result: typeof parsed; injectionFields: string[] } {
    const injectionFields: string[] = [];
    const clone = { ...parsed };

    const clean = (value: string, field: string): string => {
      const { clean: c, hadInjection } = AgentRunner.sanitiseStructuredField(value);
      if (hadInjection) { injectionFields.push(field); }
      return c;
    };

    clone.summary = clean(parsed.summary, 'summary');

    if (clone.handoffRequest) {
      clone.handoffRequest = {
        ...clone.handoffRequest,
        objective: clean(clone.handoffRequest.objective, 'handoffRequest.objective'),
        reasonForHandoff: clean(clone.handoffRequest.reasonForHandoff, 'handoffRequest.reasonForHandoff'),
      };
    }

    if (clone.reviewRequest) {
      clone.reviewRequest = {
        ...clone.reviewRequest,
        itemUnderReview: clean(clone.reviewRequest.itemUnderReview, 'reviewRequest.itemUnderReview'),
        reviewScope: clean(clone.reviewRequest.reviewScope, 'reviewRequest.reviewScope'),
      };
    }

    if (clone.blocker) {
      clone.blocker = {
        ...clone.blocker,
        reason: clean(clone.blocker.reason, 'blocker.reason'),
        suggestedRoute: clean(clone.blocker.suggestedRoute, 'blocker.suggestedRoute'),
      };
    }

    return { result: clone, injectionFields };
  }

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

    // Resolve effective provider:
    //   1. Explicit opt-in (useDefaultProvider flag or no provider type) → workspace default
    //   2. Has own API key → use own config
    //   3. No own key but workspace default is available → auto-fallback to workspace default
    //   4. No key anywhere → error
    let effectiveProvider = agentConfig.provider;
    let apiKeyId = agentId;
    const explicitDefault = agentConfig.useDefaultProvider || !agentConfig.provider?.type;

    if (explicitDefault) {
      const def = await this.configManager.readDefaultProvider();
      if (!def?.type) {
        onText('No workspace default provider configured.\nOpen Agent Settings → Default Provider to configure one.');
        return;
      }
      effectiveProvider = def;
      apiKeyId = '__default__';
    } else {
      // Check own key; if absent, auto-fallback to workspace default when available
      const needsOwnKey = (agentConfig.provider?.auth_method ?? 'api_key') !== 'gcp_adc';
      if (needsOwnKey) {
        const ownKey = await this.agentManager.getApiKey(agentId);
        if (!ownKey) {
          const def = await this.configManager.readDefaultProvider();
          if (def?.type) {
            const defNeedsKey = (def.auth_method ?? 'api_key') !== 'gcp_adc';
            const defKey = defNeedsKey ? await this.agentManager.getApiKey('__default__') : 'ok';
            if (defKey) {
              effectiveProvider = def;
              apiKeyId = '__default__';
            }
          }
        }
      }
    }

    const apiKey = await this.agentManager.getApiKey(apiKeyId);
    if (!apiKey && effectiveProvider.auth_method === 'api_key') {
      onText('API key not configured. Add a per-agent key in Agent Settings, or set a workspace default provider.');
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
    const virtualTools: MCPToolDefinition[] = [
      {
        name: 'get_diagnostics',
        description: 'Read VS Code diagnostics (Problems panel) for a file or the entire workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional relative file path to filter diagnostics.' }
          }
        }
      },
      {
        name: 'create_document',
        description: 'Create a Word document (.docx) from Markdown content and save it to the workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Output filename, e.g. "architecture.docx"' },
            title: { type: 'string', description: 'Document title (optional)' },
            content_markdown: { type: 'string', description: 'Full document body in Markdown. Use # h1, ## h2, ### h3, - bullets.' }
          },
          required: ['filename', 'content_markdown']
        }
      },
      {
        name: 'create_presentation',
        description: 'Create a PowerPoint presentation (.pptx). Use ## for each slide title, then - bullets for content.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Output filename, e.g. "design.pptx"' },
            slides_markdown: { type: 'string', description: 'Slides in Markdown: ## Slide Title\\n- bullet 1\\n- bullet 2' }
          },
          required: ['filename', 'slides_markdown']
        }
      }
    ];
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

    // Context window management — trim oldest turns when within 10% of the model's limit
    const modelName = effectiveProvider.model ?? '';
    const contextLimit = AgentRunner.MODEL_CONTEXT_LIMITS[modelName] ?? 0;
    if (contextLimit > 0) {
      const estimated = AgentRunner.estimateTokenCount(messages);
      if (estimated >= contextLimit * 0.9) {
        const KEEP_TURNS = 10;
        const systemMsgs  = messages.filter(m => m.role === 'system');
        const nonSystem   = messages.filter(m => m.role !== 'system');
        const trimmed     = nonSystem.length > KEEP_TURNS ? nonSystem.slice(nonSystem.length - KEEP_TURNS) : nonSystem;
        const removedCount = nonSystem.length - trimmed.length;
        messages.length = 0;
        messages.push(...systemMsgs, ...trimmed);
        onThought({
          type: 'thinking',
          label: `⚠ Context near limit (~${Math.round(estimated / 1000)}k / ${Math.round(contextLimit / 1000)}k tokens) — ${removedCount} oldest turn(s) trimmed`,
          timestamp: new Date()
        });
      }
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
      const APPROVAL_TOOLS = ['run_command', 'git_commit', 'git_push', 'git_create_pr', 'gcp_deploy', 'create_document', 'create_presentation'];
      let approved = true;
      if (APPROVAL_TOOLS.includes(event.name)) {
        const inp = event.input as { command?: string; message?: string; title?: string; filename?: string };
        const detail = inp.command ?? inp.message ?? inp.filename ?? inp.title ?? JSON.stringify(event.input);
        const verb = (event.name === 'create_document' || event.name === 'create_presentation') ? 'create' : 'run';
        approved = await onApproval(`Agent wants to ${verb}:\n\n${detail}\n\nAllow?`);
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
      } else if (event.name === 'create_document') {
        const { filename, title, content_markdown } = event.input as { filename: string; title?: string; content_markdown: string };
        const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        const finalPath = path.join(this.workspaceRoot, safeName.endsWith('.docx') ? safeName : safeName + '.docx');
        try {
          await generateDocx(title ?? '', content_markdown, finalPath);
          toolResultText = `Document created: ${path.basename(finalPath)}`;
        } catch (err) {
          toolResultText = `Failed to create document: ${(err as Error).message}`;
        }
      } else if (event.name === 'create_presentation') {
        const { filename, slides_markdown } = event.input as { filename: string; slides_markdown: string };
        const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        const finalPath = path.join(this.workspaceRoot, safeName.endsWith('.pptx') ? safeName : safeName + '.pptx');
        try {
          await generatePptx(slides_markdown, finalPath);
          toolResultText = `Presentation created: ${path.basename(finalPath)}`;
        } catch (err) {
          toolResultText = `Failed to create presentation: ${(err as Error).message}`;
        }
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
      // NF2-AI-002: Sanitise text fields for prompt injection patterns.
      const { result: sanitised, injectionFields } = this.sanitiseExecutionResult(parsed);

      if (injectionFields.length > 0) {
        // Log the detection without writing the offending content.
        await this.auditLogger.logPromptInjectionAttempt(agentId, injectionFields);
        onThought({
          type: 'thinking',
          label: `⚠ Prompt injection stripped from fields: ${injectionFields.join(', ')}`,
          timestamp: new Date(),
        });
      }

      onThought({
        type: 'thinking',
        label: `Structured outcome: ${sanitised.outcome}`,
        detail: JSON.stringify({ outcome: sanitised.outcome, summary: sanitised.summary }, null, 2),
        timestamp: new Date(),
      });
      return { ...sanitised, taskId, workflowId, agentId, completedAt };
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
