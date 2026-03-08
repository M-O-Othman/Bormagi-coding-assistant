import * as vscode from 'vscode';
import { AgentManager } from './AgentManager';
import { PromptComposer } from './PromptComposer';
import { MemoryManager } from './MemoryManager';
import { UndoManager } from './UndoManager';
import { SkillManager } from '../skills/SkillManager';
import { MCPHost } from '../mcp/MCPHost';
import { AuditLogger } from '../audit/AuditLogger';
import { ProviderFactory } from '../providers/ProviderFactory';
import { FileScanner, type ScannedFile } from '../utils/FileScanner';
import { ConfigManager } from '../config/ConfigManager';
import { ChatMessage, TokenUsage } from '../types';
import type { AgentExecutionResult } from '../workflow/types';
import { ExecutionOutcome } from '../workflow/enums';
import { scanForSecrets, trimToContextLimit } from './execution/ContextWindow';
import { parseStructuredCompletion, sanitiseExecutionResult } from './execution/CompletionParser';
import { ToolDispatcher } from './execution/ToolDispatcher';
import {
  buildRepoSummary,
  formatRelevantContext,
  measureRequestSize,
  minifyToolDefinitions,
  selectRelevantFileSnippets
} from './execution/PromptEfficiency';
import type { ApprovalCallback, DiffCallback, ThoughtCallback } from './execution/ToolDispatcher';
import { getAppData } from '../data/DataStore';
import { KnowledgeManager } from '../knowledge/KnowledgeManager';

// ─── Context pipeline imports ──────────────────────────────────────────────────
import { classifyMode } from '../context/ModeClassifier';
import { getModeBudget } from '../config/ModeBudgets';
import { getActiveModelProfile } from '../config/ModelProfiles';
import { enforcePreflightBudget, estimateEnvelopeTokens, estimateTokens } from '../context/BudgetEngine';
import { resolveInstructions } from '../context/InstructionResolver';
import { retrieveCandidates } from '../retrieval/RetrievalOrchestrator';
import { buildContextEnvelope } from '../context/ContextEnvelope';
import { assemblePrompt } from '../context/PromptAssembler';
import { loadRepoMap } from '../index/RepoMapStore';
import { shouldCompact, compact, formatCompactedHistory } from '../context/ContextCompactor';
import { saveCheckpoint, buildCheckpointState } from '../memory/SessionCheckpoint';
import { EnhancedSessionMemory } from '../memory/EnhancedSessionMemory';
import type { AssistantMode, CompactionInput } from '../context/types';
import { HookEngine } from '../context/HookEngine';
import { shouldCreatePlan, createPlan } from '../context/PlanManager';
import { StablePrefixCache } from '../context/StablePrefixCache';
import { loadManifests, maybeLoadCapability, defaultCapabilitiesDir } from '../context/CapabilityRegistry';

// Re-export callback types so callers that previously imported from this module continue to work.
export type { ApprovalCallback, DiffCallback, ThoughtCallback };
export type TextCallback = (delta: string) => void;
export type TokenUsageCallback = (usage: TokenUsage) => void;

interface WorkspaceContextSnapshot {
  files: ScannedFile[];
  repoSummary: string;
  cachedAt: number;
}

export class AgentRunner {
  private readonly toolDispatcher: ToolDispatcher;
  private readonly bootstrapInjected = new Set<string>();
  private readonly contextCache = new Map<string, WorkspaceContextSnapshot>();
  readonly enhancedMemory: EnhancedSessionMemory;
  private readonly stablePrefixCache = new StablePrefixCache();
  private readonly hookEngine: HookEngine;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly mcpHost: MCPHost,
    private readonly promptComposer: PromptComposer,
    private readonly memoryManager: MemoryManager,
    private readonly undoManager: UndoManager,
    private readonly skillManager: SkillManager,
    private readonly auditLogger: AuditLogger,
    private readonly configManager: ConfigManager,
    private readonly workspaceRoot: string,
    private readonly knowledgeManager?: KnowledgeManager
  ) {
    this.toolDispatcher = new ToolDispatcher(mcpHost, undoManager, auditLogger, workspaceRoot);
    this.enhancedMemory = new EnhancedSessionMemory(workspaceRoot);
    this.hookEngine = new HookEngine(workspaceRoot);
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
    // 1) Explicit default -> workspace default provider
    // 2) Agent key available -> use agent provider
    // 3) Agent key missing + default available -> fallback to default provider
    // 4) No usable key -> fail
    let effectiveProvider = agentConfig.provider;
    let apiKeyId = agentId;
    const explicitDefault = agentConfig.useDefaultProvider || !agentConfig.provider?.type;

    if (explicitDefault) {
      const def = await this.configManager.readDefaultProvider();
      if (!def?.type) {
        onText('No workspace default provider configured.\nOpen Agent Settings -> Default Provider to configure one.');
        return;
      }
      effectiveProvider = def;
      apiKeyId = '__default__';
    } else {
      const needsOwnKey = (agentConfig.provider?.auth_method ?? 'api_key') === 'api_key';
      if (needsOwnKey) {
        const ownKey = await this.agentManager.getApiKey(agentId);
        if (!ownKey) {
          const def = await this.configManager.readDefaultProvider();
          if (def?.type) {
            const defNeedsKey = (def.auth_method ?? 'api_key') === 'api_key';
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

    await this.agentManager.startMCPServersForAgent(agentId, this.workspaceRoot);

    // ─── Knowledge retrieval ──────────────────────────────────────────────────
    // Surface a thought notification when knowledge chunks are found; the context
    // pipeline (signal 3/lexical + signal 6/semantic in RetrievalOrchestrator)
    // is responsible for injecting retrieved content into the assembled prompt.
    const kbFolders = agentConfig.knowledge?.source_folders ?? [];
    if (kbFolders.length > 0 && this.knowledgeManager) {
      try {
        if (await this.knowledgeManager.hasKnowledgeBase(agentId)) {
          const evidence = await this.knowledgeManager.query(agentId, userMessage, 5);
          if (evidence.chunks.length > 0) {
            onThought({
              type: 'thinking',
              label: `Knowledge: ${evidence.chunks.length} chunks from ${evidence.trace.sources.join(', ')}`,
              detail: `Latency: ${evidence.trace.latencyMs}ms · Sources: ${evidence.trace.sources.join(', ')}`,
              timestamp: new Date(),
            });
          }
        }
      } catch (err) {
        console.warn(`AgentRunner: Knowledge retrieval failed for ${agentId}:`, err);
      }
    }

    // ─── Context pipeline ─────────────────────────────────────────────────────

    const projectConfig = await this.configManager.readProjectConfig();
    const projectName = projectConfig?.project.name ?? '';

    // 1. Classify mode from user message and log to audit.
    const modeDecision = classifyMode(userMessage);
    const mode: AssistantMode = modeDecision.mode;
    const requestId = `${agentId}-${Date.now()}`;
    const vsConfig = vscode.workspace.getConfiguration('bormagi');
    const enhancedPipeline = vsConfig.get<boolean>('contextPipeline.enabled', false);
    await this.auditLogger.logModeClassified(
      requestId,
      mode,
      modeDecision.confidence,
      modeDecision.userOverride,
      modeDecision.reason,
    );

    // ─── Phase-5: session-start hook + plan creation ───────────────────────────
    if (enhancedPipeline) {
      await this.hookEngine.onSessionStart({ mode });
      if (shouldCreatePlan(userMessage, modeDecision)) {
        createPlan(this.workspaceRoot, userMessage.slice(0, 200), [], mode);
      }
    }

    // 2. Load mode budget and model profile.
    const budget = getModeBudget(mode);
    const profile = getActiveModelProfile(effectiveProvider);

    // 3. Resolve instructions from .bormagi/instructions/{global,repo}.md.
    const instructions = resolveInstructions(this.workspaceRoot);

    // 4. Load repo map from .bormagi/repo-map.json (null if not yet built).
    const repoMap = loadRepoMap(this.workspaceRoot);

    // 5. Gather, score, and rank context candidates.
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const retrievalQuery = { text: userMessage, mode, activeFile };
    const candidates = await retrieveCandidates(
      retrievalQuery,
      { workspaceRoot: this.workspaceRoot, repoMap, activeFilePath: activeFile, agentId },
      budget.retrievedContext,
    );

    // 6. Partition candidates into envelope slots (editable / reference / memory / toolOutputs).
    const envelope = buildContextEnvelope(candidates, mode);

    // 7. Enforce token budget — prunes envelope sections if over the soft limit.
    enforcePreflightBudget(envelope, budget, profile);

    // 8. Assemble full system prompt.
    //    systemPreamble comes from the agent's configured prompt files (unchanged path).
    const systemPreamble = await this.promptComposer.compose(agentConfig, projectName);
    await this.skillManager.loadAll();
    const skillsSection = this.skillManager.buildSkillsPromptSection();
    const assembledSystem = assemblePrompt({
      systemPreamble,
      instructions,
      envelope,
      repoMap,
      userMessage,
      mode,
      agentName: agentConfig.name,
      projectName,
    });
    let fullSystem = skillsSection ? `${assembledSystem}\n\n${skillsSection}` : assembledSystem;

    // ─── Phase-5: capability injection + stable prefix cache ──────────────────
    if (enhancedPipeline) {
      const capDir = vsConfig.get<string>('contextPipeline.capabilities.dir', '') ||
                     defaultCapabilitiesDir(this.workspaceRoot);
      const capBudget = vsConfig.get<number>('contextPipeline.capabilities.maxBudgetTokens', 1500);
      const manifests = loadManifests(capDir);
      const capability = await maybeLoadCapability(manifests, userMessage, mode, capBudget, requestId);
      if (capability) {
        fullSystem = `${fullSystem}\n\n## Capability: ${capability.name}\n${capability.instructions}`;
      }

      const { segment, hit } = this.stablePrefixCache.getOrRegister('system', fullSystem);
      if (hit) {
        await this.auditLogger.logCacheHit(agentId, segment.cacheKey, 'system-preamble', estimateTokens(fullSystem));
      } else {
        await this.auditLogger.logCacheMiss(agentId, segment.cacheKey, 'system-preamble');
      }
    }

    // 9. Build conversation messages (system + history + user turn).
    //    Bootstrap injection and ad-hoc retrieval context are now handled by the
    //    context pipeline above, so those intermediate messages are no longer needed.
    const sessionHistory = await this.memoryManager.getSessionHistoryWithMemory(agentId);
    const messages: ChatMessage[] = [
      { role: 'system', content: fullSystem },
      ...sessionHistory,
    ];

    const bootstrapContext = ''; // kept for measureRequestSize compat — pipeline handles context
    const retrievalContext = ''; // kept for measureRequestSize compat — pipeline handles context

    const userMsg: ChatMessage = { role: 'user', content: userMessage };
    messages.push(userMsg);
    this.memoryManager.addMessage(agentId, userMsg);

    const rawTools = [...this.mcpHost.getAllTools(), ...getAppData().virtualTools];
    const tools = minifyToolDefinitions(rawTools);

    // Secret scan before sending context to the model.
    const secretHits = scanForSecrets(messages);
    if (secretHits.length > 0) {
      onThought({
        type: 'error',
        label: `Warning: ${secretHits.length} potential secret(s) detected in context`,
        detail: 'Sensitive patterns (API keys, tokens, private keys) were found in model context. Review before continuing.',
        timestamp: new Date()
      });
    }

    // Trim context when near model limit.
    const trim = trimToContextLimit(messages, effectiveProvider.model ?? '');
    if (trim.didTrim) {
      onThought({
        type: 'thinking',
        label: `Context near limit (~${Math.round(trim.estimatedTokens / 1000)}k / ${Math.round(trim.contextLimit / 1000)}k tokens) - trimmed ${trim.removedCount} oldest turn(s)`,
        timestamp: new Date()
      });
    }

    // ─── Context compaction ───────────────────────────────────────────────────
    // Estimate history token count and compact proactively when it approaches
    // the model's soft input budget (80 % threshold, ≥ 6 messages).
    const historyTokens = estimateTokens(sessionHistory.map(m => m.content).join(' '));
    const providerConfig = { ...agentConfig, provider: effectiveProvider };
    const provider = ProviderFactory.create(providerConfig, apiKey);

    if (shouldCompact(historyTokens, profile, sessionHistory.length)) {
      onThought({
        type: 'thinking',
        label: 'Compacting conversation history…',
        detail: `History: ~${historyTokens} tokens, threshold: ${Math.floor(profile.recommendedInputBudget * 0.8)}`,
        timestamp: new Date(),
      });

      const compactionInput: CompactionInput = {
        transcript: sessionHistory.map(m => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content })),
        recentArtifacts: this.enhancedMemory.getState(agentId).recentEditedFiles.slice(0, 10),
        activeMode: mode,
        currentGoal: this.enhancedMemory.getState(agentId).currentGoal,
      };

      const compactionResult = await compact(compactionInput, provider, mode);
      const triggerPct = Math.round((historyTokens / profile.recommendedInputBudget) * 100);
      await this.auditLogger.logCompactionTriggered(
        agentId,
        triggerPct,
        historyTokens,
        0, // tokensAfter not measured here — summary is compact by design
        requestId,
      );

      // Replace history with compact summary as a single assistant turn.
      const compactMsg: ChatMessage = {
        role: 'assistant',
        content: compactionResult.narrative,
      };
      // Rebuild messages: system + compact summary + user turn.
      messages.splice(1, messages.length - 1, compactMsg, userMsg);

      onThought({
        type: 'thinking',
        label: `Compaction complete — ${compactionResult.droppedMessages} messages condensed`,
        timestamp: new Date(),
      });

      // ─── Phase-5: after-compaction hook ──────────────────────────────────
      if (enhancedPipeline) {
        await this.hookEngine.onAfterCompaction({ mode });
      }
    }

    // ─── Phase-5: before-final hook ───────────────────────────────────────────
    if (enhancedPipeline) {
      await this.hookEngine.runHooks('before-final', { mode });
    }

    const maxOutputTokens = Math.max(
      128,
      vsConfig.get<number>('maxOutputTokens', 1200)
    );

    let fullResponse = '';
    const toolsUsed: string[] = [];
    let continueLoop = true;
    let isFirstModelRequest = true;

    while (continueLoop) {
      continueLoop = false;
      let calledATool = false;

      if (isFirstModelRequest) {
        const size = measureRequestSize({
          systemPrompt: fullSystem,
          history: sessionHistory,
          repoSummaryContext: bootstrapContext,
          retrievalContext,
          userMessage,
          tools
        });

        onThought({
          type: 'thinking',
          label: `Request size: ${size.totalBytes} bytes (~${Math.round(size.estimatedInputTokens)} input tokens est.)`,
          detail: JSON.stringify({
            systemChars: size.systemChars,
            historyChars: size.historyChars,
            repoSummaryChars: size.repoSummaryChars,
            retrievalChars: size.retrievalChars,
            userChars: size.userChars,
            toolSchemaChars: size.toolSchemaChars,
            totalChars: size.totalChars,
            totalBytes: size.totalBytes,
            estimatedInputTokens: size.estimatedInputTokens,
            contextCacheHit: false
          }, null, 2),
          timestamp: new Date()
        });

        await this.auditLogger.logLLMRequest(
          agentId,
          effectiveProvider.type,
          effectiveProvider.model,
          {
            phase: 'initial',
            systemChars: size.systemChars,
            historyChars: size.historyChars,
            repoSummaryChars: size.repoSummaryChars,
            retrievalChars: size.retrievalChars,
            userChars: size.userChars,
            toolSchemaChars: size.toolSchemaChars,
            totalChars: size.totalChars,
            totalBytes: size.totalBytes,
            estimatedInputTokens: size.estimatedInputTokens,
            contextCacheHit: false
          }
        );

        isFirstModelRequest = false;
      }

      for await (const event of provider.stream(messages, tools, maxOutputTokens)) {
        if (event.type === 'provider_headers') {
          const importantHeaders = this.selectImportantHeaders(event.headers);
          await this.auditLogger.logLLMResponseHeaders(
            agentId,
            effectiveProvider.type,
            effectiveProvider.model,
            importantHeaders
          );

          if (Object.keys(importantHeaders).length > 0) {
            onThought({
              type: 'thinking',
              label: 'Provider response headers captured',
              detail: JSON.stringify(importantHeaders, null, 2),
              timestamp: new Date()
            });
          }
        } else if (event.type === 'token_usage') {
          onTokenUsage?.(event.usage);

          const cacheCreation = event.usage.cacheCreationInputTokens ?? 0;
          const cacheRead = event.usage.cacheReadInputTokens ?? 0;
          if (cacheCreation > 0 || cacheRead > 0) {
            onThought({
              type: 'thinking',
              label: `Prompt cache usage: read=${cacheRead}, create=${cacheCreation}`,
              timestamp: new Date()
            });
          }
        } else if (event.type === 'text') {
          onText(event.delta);
          fullResponse += event.delta;
        } else if (event.type === 'tool_use') {
          toolsUsed.push(event.name);
          const toolResult = await this.toolDispatcher.dispatch(
            event, agentId, onApproval, onDiff, onThought
          );
          messages.push({ role: 'user', content: `[Tool result: ${event.name}]\n${toolResult}` });
          calledATool = true;
          continueLoop = true;
          // ─── Phase-5: after-edit hook for file-mutation tools ──────────────
          if (enhancedPipeline && (event.name.includes('write') || event.name.includes('edit'))) {
            await this.hookEngine.onAfterEdit([event.name], { mode });
          }
        }
      }

      if (!calledATool) {
        continueLoop = false;
      }
    }

    // Persist completed turn.
    if (fullResponse) {
      const assistantMsg: ChatMessage = { role: 'assistant', content: fullResponse };
      this.memoryManager.addMessage(agentId, assistantMsg);
      await this.memoryManager.persistTurn(agentId, userMessage, fullResponse, toolsUsed);

      // Update enhanced session memory with the files touched this turn.
      for (const file of toolsUsed.filter(t => t.includes('write') || t.includes('edit'))) {
        this.enhancedMemory.recordEditedFile(agentId, file);
      }
      await this.enhancedMemory.persistState(agentId);

      // Save a session checkpoint so the session can be resumed after restart.
      await saveCheckpoint(this.workspaceRoot, buildCheckpointState(requestId, {
        activeMode:            mode,
        currentPlan:           this.enhancedMemory.getState(agentId).currentPlan,
        recentEditedFiles:     this.enhancedMemory.getState(agentId).recentEditedFiles,
        pendingToolArtifacts:  toolsUsed,
      }));
    }
  }

  // WF-202: Structured completion for workflow orchestration.

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
          label: `Warning: prompt injection stripped from fields: ${injectionFields.join(', ')}`,
          timestamp: new Date()
        });
      }

      onThought({
        type: 'thinking',
        label: `Structured outcome: ${sanitised.outcome}`,
        detail: JSON.stringify({ outcome: sanitised.outcome, summary: sanitised.summary }, null, 2),
        timestamp: new Date()
      });

      return { ...sanitised, taskId, workflowId, agentId, completedAt };
    }

    return {
      taskId, workflowId, agentId,
      outcome: ExecutionOutcome.Completed,
      summary: fullResponse.slice(0, 500),
      producedArtifactIds: [],
      delegateTo: null,
      handoffRequest: null,
      reviewRequest: null,
      blocker: null,
      completedAt
    };
  }

  /**
   * Public wrapper - delegates to CompletionParser.
   * Prefer importing parseStructuredCompletion from execution/CompletionParser directly.
   */
  parseStructuredCompletion(
    responseText: string
  ): Omit<AgentExecutionResult, 'taskId' | 'workflowId' | 'agentId' | 'completedAt'> | null {
    return parseStructuredCompletion(responseText);
  }

  private async getWorkspaceContext(
    agentId: string,
    agentConfig: { context_filter: { include_extensions: string[]; exclude_patterns: string[] } }
  ): Promise<{ files: ScannedFile[]; repoSummary: string; cacheHit: boolean }> {
    try {
      const vsConfig = vscode.workspace.getConfiguration('bormagi');
      const cacheTtlSeconds = Math.max(10, vsConfig.get<number>('contextCacheTtlSeconds', 120));
      const now = Date.now();

      const cached = this.contextCache.get(agentId);
      if (cached && now - cached.cachedAt < cacheTtlSeconds * 1000) {
        return { files: cached.files, repoSummary: cached.repoSummary, cacheHit: true };
      }

      const maxFiles = vsConfig.get<number>('contextMaxFiles', 50);
      const maxFileSizeKb = vsConfig.get<number>('contextMaxFileSizeKb', 100);
      const repoSummaryChars = Math.max(600, vsConfig.get<number>('contextRepoSummaryChars', 2400));

      const scanner = new FileScanner(this.workspaceRoot);
      const files = await scanner.scanWorkspace(
        new Set(agentConfig.context_filter.include_extensions),
        agentConfig.context_filter.exclude_patterns,
        maxFiles,
        maxFileSizeKb
      );

      const repoSummary = buildRepoSummary(files, repoSummaryChars);
      this.contextCache.set(agentId, { files, repoSummary, cachedAt: now });
      return { files, repoSummary, cacheHit: false };
    } catch {
      return { files: [], repoSummary: '', cacheHit: false };
    }
  }

  private buildTaskRetrievalContext(files: ScannedFile[], userMessage: string): string {
    if (!userMessage.trim()) {
      return '';
    }
    const vsConfig = vscode.workspace.getConfiguration('bormagi');
    const topFiles = Math.max(1, vsConfig.get<number>('contextRetrievalTopFiles', 6));
    const snippetChars = Math.max(250, vsConfig.get<number>('contextRetrievalSnippetChars', 900));

    const snippets = selectRelevantFileSnippets(files, userMessage, topFiles, snippetChars);
    return formatRelevantContext(userMessage, snippets);
  }

  private selectImportantHeaders(headers: Record<string, string>): Record<string, string> {
    const keep = new Set([
      'retry-after',
      'x-request-id',
      'request-id',
      'anthropic-ratelimit-input-tokens-limit',
      'anthropic-ratelimit-input-tokens-remaining',
      'anthropic-ratelimit-input-tokens-reset',
      'anthropic-ratelimit-output-tokens-limit',
      'anthropic-ratelimit-output-tokens-remaining',
      'anthropic-ratelimit-output-tokens-reset',
      'anthropic-ratelimit-requests-limit',
      'anthropic-ratelimit-requests-remaining',
      'anthropic-ratelimit-requests-reset'
    ]);

    const out: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(headers)) {
      const key = rawKey.toLowerCase();
      if (keep.has(key) || key.includes('ratelimit') || key.includes('request-id')) {
        out[key] = value;
      }
    }
    return out;
  }
}
