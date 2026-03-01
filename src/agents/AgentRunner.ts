import * as vscode from 'vscode';
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
import { ChatMessage, TokenUsage } from '../types';
import type { AgentExecutionResult } from '../workflow/types';
import { ExecutionOutcome } from '../workflow/enums';
import { scanForSecrets, trimToContextLimit } from './execution/ContextWindow';
import { parseStructuredCompletion, sanitiseExecutionResult } from './execution/CompletionParser';
import { ToolDispatcher } from './execution/ToolDispatcher';
import type { ApprovalCallback, DiffCallback, ThoughtCallback } from './execution/ToolDispatcher';
import { getAppData } from '../data/DataStore';

// Re-export callback types so callers that previously imported from this module continue to work.
export type { ApprovalCallback, DiffCallback, ThoughtCallback };
export type TextCallback       = (delta: string) => void;
export type TokenUsageCallback = (usage: TokenUsage) => void;

export class AgentRunner {
  private readonly toolDispatcher: ToolDispatcher;

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
  ) {
    this.toolDispatcher = new ToolDispatcher(mcpHost, undoManager, auditLogger, workspaceRoot);
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

    // ─── Resolve effective provider ───────────────────────────────────────────
    // 1. Explicit opt-in (useDefaultProvider or no type) → workspace default
    // 2. Has own API key → use own config
    // 3. No own key but workspace default available → auto-fallback
    // 4. No key anywhere → error
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
      const needsOwnKey = (agentConfig.provider?.auth_method ?? 'api_key') !== 'gcp_adc';
      if (needsOwnKey) {
        const ownKey = await this.agentManager.getApiKey(agentId);
        if (!ownKey) {
          const def = await this.configManager.readDefaultProvider();
          if (def?.type) {
            const defNeedsKey = (def.auth_method ?? 'api_key') !== 'gcp_adc';
            const defKey      = defNeedsKey ? await this.agentManager.getApiKey('__default__') : 'ok';
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

    await this.agentManager.startMCPServersForAgent(agentId, this.workspaceRoot);

    // ─── Build prompt and message history ─────────────────────────────────────
    const projectConfig  = await this.configManager.readProjectConfig();
    const projectName    = projectConfig?.project.name ?? '';
    const systemPrompt   = await this.promptComposer.compose(agentConfig, projectName);
    await this.skillManager.loadAll();
    const skillsSection  = this.skillManager.buildSkillsPromptSection();
    const fullSystem     = skillsSection ? `${systemPrompt}\n\n${skillsSection}` : systemPrompt;
    const contextSummary = await this.buildContextSummary(agentConfig);

    const sessionHistory = await this.memoryManager.getSessionHistoryWithMemory(agentId);
    const messages: ChatMessage[] = [
      { role: 'system', content: fullSystem },
      ...sessionHistory,
    ];

    if (contextSummary) {
      messages.push({ role: 'user',      content: `[Workspace context]\n${contextSummary}` });
      messages.push({ role: 'assistant', content: 'I have reviewed the workspace context. How can I help you?' });
    }

    const userMsg: ChatMessage = { role: 'user', content: userMessage };
    messages.push(userMsg);
    this.memoryManager.addMessage(agentId, userMsg);

    const tools = [...this.mcpHost.getAllTools(), ...getAppData().virtualTools];

    // ─── Secret scan ──────────────────────────────────────────────────────────
    const secretHits = scanForSecrets(messages);
    if (secretHits.length > 0) {
      onThought({
        type:      'error',
        label:     `⚠ ${secretHits.length} potential secret(s) detected in context`,
        detail:    'Sensitive patterns (API keys, tokens, private keys) found in context being sent to the LLM. Review and remove them if unintended.',
        timestamp: new Date(),
      });
    }

    // ─── Context window trim ──────────────────────────────────────────────────
    const trim = trimToContextLimit(messages, effectiveProvider.model ?? '');
    if (trim.didTrim) {
      onThought({
        type:      'thinking',
        label:     `⚠ Context near limit (~${Math.round(trim.estimatedTokens / 1000)}k / ${Math.round(trim.contextLimit / 1000)}k tokens) — ${trim.removedCount} oldest turn(s) trimmed`,
        timestamp: new Date(),
      });
    }

    // ─── LLM streaming loop ───────────────────────────────────────────────────
    const providerConfig = { ...agentConfig, provider: effectiveProvider };
    const provider       = ProviderFactory.create(providerConfig, apiKey);

    let fullResponse = '';
    const toolsUsed: string[] = [];
    let continueLoop = true;

    while (continueLoop) {
      continueLoop = false;
      let calledATool = false;

      for await (const event of provider.stream(messages, tools)) {
        if (event.type === 'token_usage') {
          onTokenUsage?.(event.usage);
        } else if (event.type === 'text') {
          onText(event.delta);
          fullResponse += event.delta;
        } else if (event.type === 'tool_use') {
          toolsUsed.push(event.name);
          const toolResult = await this.toolDispatcher.dispatch(
            event, agentId, onApproval, onDiff, onThought
          );
          messages.push({ role: 'user', content: `[Tool result: ${event.name}]\n${toolResult}` });
          calledATool  = true;
          continueLoop = true;
        }
      }

      if (!calledATool) { continueLoop = false; }
    }

    // ─── Persist turn ─────────────────────────────────────────────────────────
    if (fullResponse) {
      const assistantMsg: ChatMessage = { role: 'assistant', content: fullResponse };
      this.memoryManager.addMessage(agentId, assistantMsg);
      await this.memoryManager.persistTurn(agentId, userMessage, fullResponse, toolsUsed);
    }
  }

  // ─── WF-202: Structured completion for workflow orchestration ────────────────

  /**
   * Run the agent and return a typed AgentExecutionResult.
   * See docs/agent-protocol.md for the structured completion payload format.
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
    const capturingOnText: TextCallback = (delta) => { fullResponse += delta; onText(delta); };

    await this.run(agentId, userMessage, capturingOnText, onThought, onApproval, onDiff, onTokenUsage);

    const completedAt = new Date().toISOString();
    const parsed = parseStructuredCompletion(fullResponse);

    if (parsed) {
      const { result: sanitised, injectionFields } = sanitiseExecutionResult(parsed);

      if (injectionFields.length > 0) {
        await this.auditLogger.logPromptInjectionAttempt(agentId, injectionFields);
        onThought({
          type: 'thinking',
          label: `⚠ Prompt injection stripped from fields: ${injectionFields.join(', ')}`,
          timestamp: new Date(),
        });
      }

      onThought({
        type:      'thinking',
        label:     `Structured outcome: ${sanitised.outcome}`,
        detail:    JSON.stringify({ outcome: sanitised.outcome, summary: sanitised.summary }, null, 2),
        timestamp: new Date(),
      });

      return { ...sanitised, taskId, workflowId, agentId, completedAt };
    }

    return {
      taskId, workflowId, agentId,
      outcome:             ExecutionOutcome.Completed,
      summary:             fullResponse.slice(0, 500),
      producedArtifactIds: [],
      delegateTo:          null,
      handoffRequest:      null,
      reviewRequest:       null,
      blocker:             null,
      completedAt,
    };
  }

  /**
   * Public wrapper — delegates to CompletionParser.
   * Prefer importing parseStructuredCompletion from execution/CompletionParser directly.
   */
  parseStructuredCompletion(
    responseText: string
  ): Omit<AgentExecutionResult, 'taskId' | 'workflowId' | 'agentId' | 'completedAt'> | null {
    return parseStructuredCompletion(responseText);
  }

  private async buildContextSummary(
    agentConfig: { context_filter: { include_extensions: string[]; exclude_patterns: string[] } }
  ): Promise<string> {
    try {
      const vsConfig      = vscode.workspace.getConfiguration('bormagi');
      const maxFiles      = vsConfig.get<number>('contextMaxFiles', 50);
      const maxFileSizeKb = vsConfig.get<number>('contextMaxFileSizeKb', 100);

      const scanner = new FileScanner(this.workspaceRoot);
      const files   = await scanner.scanWorkspace(
        new Set(agentConfig.context_filter.include_extensions),
        agentConfig.context_filter.exclude_patterns,
        maxFiles,
        maxFileSizeKb
      );

      if (files.length === 0) { return ''; }

      return files.map(f =>
        `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``
      ).join('\n\n');
    } catch {
      return '';
    }
  }
}
