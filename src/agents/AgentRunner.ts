import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentLogger } from './AgentLogger';
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
import { RetrievalService } from '../knowledge/RetrievalService';
import type { EvidencePack } from '../knowledge/types';
import { TurnMemory } from '../memory/TurnMemory';
import { Consolidator } from '../memory/Consolidator';
import { DecisionManager } from '../memory/DecisionManager';
import { DelegationManager } from '../collaboration/DelegationManager';
import { SandboxManager } from '../sandbox/SandboxManager';
import { PolicyEngine } from '../sandbox/PolicyEngine';
import { ApprovalService } from '../sandbox/ApprovalService';
import { ExecWrapper, PromptApprovalCallback } from '../sandbox/ExecWrapper';
import { GitService } from '../git/GitService';
import { CheckpointManager } from '../git/CheckpointManager';
import { ValidationService } from '../git/ValidationService';
import { CommitProposalGenerator } from '../git/CommitProposalGenerator';
import { ExecutionStateManager, type ExecutionStateData } from './ExecutionStateManager';

// ─── Sandbox imports ────────────────────────────────────────────────────────
import { SandboxHandle } from '../sandbox/types';

// ─── Context pipeline imports ──────────────────────────────────────────────────
import { classifyMode, classifyModeWithLLM } from '../context/ModeClassifier';
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
export type CompactionCallback = (droppedCount: number, preservedItems: string[]) => void;
export type PlanCreatedCallback = (plan: import('../context/types').ExecutionPlan) => void;
export type DiffSummaryCallback = (changedFiles: string[], intent: string, checkpointRef?: string) => void;
export type CheckpointCreatedCallback = (checkpointId: string, label: string, changedFiles: string[]) => void;
export type ContextUpdateCallback = (
  items: Array<{ id: string; itemType: string; label: string; source: string; reasonIncluded: string; estimatedTokens?: number; removable: boolean }>,
  tokenHealth: 'healthy' | 'busy' | 'near-limit',
) => void;

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
  private activeSandbox: SandboxHandle | null = null;
  private execWrapper: ExecWrapper | null = null;
  private readonly gitService: GitService;
  private readonly checkpointManager: CheckpointManager;
  private readonly validationService: ValidationService;
  private readonly commitGenerator: CommitProposalGenerator;
  private currentCheckpointId: string | null = null;

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
    private readonly knowledgeManager?: KnowledgeManager,
    private readonly delegationManager?: DelegationManager,
    private readonly consolidator?: Consolidator,
    private readonly decisionManager?: DecisionManager,
    private readonly policyEngine?: PolicyEngine,
    private readonly approvalService?: ApprovalService,
    private readonly sandboxManager?: SandboxManager
  ) {
    this.gitService = new GitService(workspaceRoot);
    this.checkpointManager = new CheckpointManager(workspaceRoot);
    this.validationService = new ValidationService(workspaceRoot);
    this.commitGenerator = new CommitProposalGenerator(this.gitService);

    if (this.policyEngine && this.approvalService) {
      this.execWrapper = new ExecWrapper(
        this.policyEngine,
        this.approvalService,
        // Interactive user prompt for execution policy overrides
        async (cmd, reason, rule) => {
          const res = await vscode.window.showWarningMessage(
            `Sandbox Policy: Agent wants to run a shell command.\nCommand: ${cmd}\nMatched Rule: ${rule}`,
            { modal: true },
            'Allow Once',
            'Allow for Task',
            'Allow for Project',
            'Deny'
          );

          if (res === 'Allow Once') return { allow: true, scope: 'once' };
          if (res === 'Allow for Task') return { allow: true, scope: 'task' };
          if (res === 'Allow for Project') return { allow: true, scope: 'project' };

          return { allow: false, scope: 'once' };
        },
        // Real execute via MCP
        async (cmd) => {
          try {
            const tc = { name: 'run_command', input: { command: cmd } };
            // Depending on how MCP returns, we will fake a 0 exit code on success.
            const res = await this.mcpHost.callTool('terminal', tc);
            const text = res.content.map(c => c.text).join('\n');
            return { stdout: text, stderr: '', exitCode: 0, durationMs: 0 };
          } catch (err: any) {
            return { stdout: '', stderr: err.message, exitCode: 1, durationMs: 0 };
          }
        }
      );
    }

    this.toolDispatcher = new ToolDispatcher(mcpHost, undoManager, auditLogger, workspaceRoot, this.execWrapper);
    this.enhancedMemory = new EnhancedSessionMemory(workspaceRoot);
    this.hookEngine = new HookEngine(workspaceRoot);
  }

  get git(): GitService {
    return this.gitService;
  }

  get checkpoints(): CheckpointManager {
    return this.checkpointManager;
  }


  async run(
    agentId: string,
    userMessage: string,
    onText: TextCallback,
    onThought: ThoughtCallback,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    onTokenUsage?: TokenUsageCallback,
    onCompaction?: CompactionCallback,
    onPlanCreated?: PlanCreatedCallback,
    onDiffSummary?: DiffSummaryCallback,
    onCheckpointCreated?: CheckpointCreatedCallback,
    onContextUpdate?: ContextUpdateCallback,
    userMode?: import('../context/types').AssistantMode,
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

    const vsConfig = vscode.workspace.getConfiguration('bormagi');
    const isSandboxEnabled = vsConfig.get<boolean>('sandbox.enabled', false);

    // Initialise sandbox
    if (this.sandboxManager && !this.activeSandbox && isSandboxEnabled) {
      onThought({ type: 'thinking', label: 'Initializing Sandbox', timestamp: new Date() });
      this.activeSandbox = await this.sandboxManager.create({
        taskId: `task-${Date.now()}`,
        repoPathOrRemote: this.workspaceRoot,
        baseRef: '',
        isolationMode: 'local_worktree_sandbox',
        policyBundleId: 'default',
        writable: true,
        networkMode: 'deny_all'
      });
      this.toolDispatcher.activeSandbox = this.activeSandbox;
    } else if (!isSandboxEnabled) {
      this.toolDispatcher.activeSandbox = null;
      onThought({ type: 'thinking', label: 'Sandbox disabled. Writing directly to workspace.', timestamp: new Date() });
    }

    const providerParams = { apiKey: apiKey ?? '', ...effectiveProvider };
    const maxTokens = vsConfig.get<number>('advanced.maxTokens') || 30000;
    // Ensure the output tokens matches the value we deducted from the safety ceiling
    const actualMaxOutputTokens = Math.max(
      vsConfig.get<number>('maxOutputTokens', 8000),
      // Minimum 8000 to accommodate large file writes (analog clocks, full components, etc.)
      8000
    );
    // Deduct maxOutputTokens to ensure input + output stays under the rate limit
    const safeInputTokens = Math.max(1000, maxTokens - actualMaxOutputTokens);

    // ─── Semantic Session Setup ───────────────────────────────────────────────
    // We instantiate a TurnMemory to track episodic context for this specific run
    const turnMemory = new TurnMemory();
    const currentTurn = turnMemory.startTurn(userMessage);

    // ─── Knowledge retrieval ──────────────────────────────────────────────────
    // Surface a thought notification when knowledge chunks are found; the context
    // pipeline (signal 3/lexical + signal 6/semantic in RetrievalOrchestrator)
    // is responsible for injecting retrieved content into the assembled prompt.
    let kbEvidence: EvidencePack | null = null;
    const kbFolders = agentConfig.knowledge?.source_folders ?? [];
    if (kbFolders.length > 0 && this.knowledgeManager) {
      try {
        if (await this.knowledgeManager.hasKnowledgeBase(agentId)) {
          kbEvidence = await this.knowledgeManager.query(agentId, userMessage, 5);
          if (kbEvidence.chunks.length > 0) {
            turnMemory.addEvidenceSources(kbEvidence.trace.sources);
            onThought({
              type: 'thinking',
              label: `Knowledge: ${kbEvidence.chunks.length} chunks from ${kbEvidence.trace.sources.join(', ')}`,
              detail: `Latency: ${kbEvidence.trace.latencyMs}ms · Sources: ${kbEvidence.trace.sources.join(', ')}`,
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

    // 1. Classify mode — use explicitly set userMode if provided, otherwise auto-detect.
    //    When a classifierProvider is configured, delegate to the secondary LLM.
    let modeDecision = classifyMode(userMessage);
    if (!userMode) {
      const classifierProviderCfg = await this.configManager.readClassifierProvider();
      if (classifierProviderCfg) {
        const classifierKey = await this.agentManager.getApiKey('__classifier__');
        if (classifierKey || classifierProviderCfg.auth_method !== 'api_key') {
          const classifierLLM = ProviderFactory.create(
            { ...agentConfig, provider: classifierProviderCfg },
            classifierKey,
          );
          modeDecision = await classifyModeWithLLM(userMessage, classifierLLM);
          onThought({
            type: 'thinking',
            label: `Mode classified by LLM (${classifierProviderCfg.model}): ${modeDecision.mode}`,
            timestamp: new Date(),
          });
        }
      }
    }
    const mode: AssistantMode = userMode ?? modeDecision.mode;
    const requestId = `${agentId}-${Date.now()}`;
    const agentLog = new AgentLogger(this.workspaceRoot, agentId);
    agentLog.sessionStart(mode);
    const enhancedPipeline = vsConfig.get<boolean>('contextPipeline.enabled', false);

    // ─── Phase-1: Git Capabilities & Pre-Edit State (FR-001, FR-006, FR-020) ─
    const gitContext = await this.gitService.getStatus(this.workspaceRoot);
    if (gitContext.state !== "clean" && enhancedPipeline) {
      onThought({
        type: 'thinking',
        label: `Repository is dirty (${gitContext.state}). Extracting Git snapshot.`,
        timestamp: new Date()
      });
    }

    // Automatically checkpoint the workspace BEFORE starting any new task iterations
    if (enhancedPipeline && !this.currentCheckpointId) {
      const checkpt = await this.checkpointManager.createCheckpoint('task_start', `Start Task: ${userMessage.substring(0, 25)}`);
      this.currentCheckpointId = checkpt.id;
      turnMemory.addToolResult('system_checkpoint', `A Git Checkpoint was successfully created before this task began (ID: ${checkpt.id}).`);
      onCheckpointCreated?.(checkpt.id, `Task start: ${userMessage.substring(0, 40)}`, []);
    }

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
        const newPlan = createPlan(this.workspaceRoot, userMessage.slice(0, 200), [], mode);
        onPlanCreated?.(newPlan);
      }
    }

    // 2. Load mode budget and model profile.
    //    Cap recommendedInputBudget to maxTokens to respect API rate limits.
    const budget = getModeBudget(mode);
    const _baseProfile = getActiveModelProfile(effectiveProvider);
    const profile = safeInputTokens < _baseProfile.recommendedInputBudget
      ? { ..._baseProfile, recommendedInputBudget: safeInputTokens }
      : _baseProfile;

    // 3. Load repo map from .bormagi/repo-map.json (null if not yet built).
    const repoMap = loadRepoMap(this.workspaceRoot);

    // 4. Gather, score, and rank context candidates.
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const retrievalQuery = { text: userMessage, mode, activeFile };
    const candidates = await retrieveCandidates(
      retrievalQuery,
      { workspaceRoot: this.workspaceRoot, repoMap, activeFilePath: activeFile, agentId },
      Math.min(budget.retrievedContext, Math.floor(safeInputTokens * 0.2)),
    );

    // 5. Build candidate paths for YAML instruction glob matching
    const candidatePaths = candidates.map(c => c.path || '').filter(Boolean);
    if (gitContext && gitContext.changedPaths) {
      gitContext.changedPaths.forEach(cp => candidatePaths.push(cp.path));
    }

    // 6. Resolve instructions from .bormagi and .github files, scoped by paths
    const instructions = resolveInstructions(this.workspaceRoot, candidatePaths);

    // 6. Partition candidates into envelope slots (editable / reference / memory / toolOutputs).
    const envelope = buildContextEnvelope(candidates, mode);

    // 7. Enforce token budget — prunes envelope sections if over the soft limit.
    const enforcement = enforcePreflightBudget(envelope, budget, profile);
    const effectiveEnvelope = enforcement.envelope;

    // 8. Assemble full system prompt.
    //    systemPreamble comes from the agent's configured prompt files (unchanged path).
    const systemPreamble = await this.promptComposer.compose(agentConfig, projectName);
    await this.skillManager.loadAll();
    const skillsSection = this.skillManager.buildSkillsPromptSection();
    const assembledSystem = assemblePrompt({
      systemPreamble,
      instructions,
      envelope: effectiveEnvelope,
      repoMap,
      userMessage,
      mode,
      agentName: agentConfig.name,
      projectName,
    });
    let fullSystem = skillsSection ? `${assembledSystem}\n\n${skillsSection}` : assembledSystem;
    agentLog.logSystemPrompt(fullSystem);

    if (kbEvidence && kbEvidence.chunks.length > 0) {
      const formattedEvidence = RetrievalService.formatEvidenceForPrompt(kbEvidence);
      fullSystem = `${fullSystem}\n\n${formattedEvidence}\n\nCRITICAL INSTRUCTION: You MUST base your response on the [Evidence from Knowledge Base] provided above. If the evidence provides information about the user's query, you must use it and cite the sources.`;
    }

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

    // ─── Emit context_update ──────────────────────────────────────────────────
    if (onContextUpdate) {
      const systemTokens = estimateTokens(fullSystem);
      const tokenHealth: 'healthy' | 'busy' | 'near-limit' =
        systemTokens > profile.recommendedInputBudget * 0.9 ? 'near-limit'
          : systemTokens > profile.recommendedInputBudget * 0.7 ? 'busy'
            : 'healthy';

      const ctxItems: Array<{ id: string; itemType: string; label: string; source: string; reasonIncluded: string; estimatedTokens?: number; removable: boolean }> = [];

      // Mode
      ctxItems.push({ id: 'mode', itemType: 'mode', label: mode, source: 'system', reasonIncluded: 'Active assistant mode', removable: false });

      // Instruction layers
      for (const layer of instructions.layers) {
        if (!layer.missing) {
          ctxItems.push({
            id: `layer:${layer.role}`,
            itemType: 'instruction',
            label: layer.role === 'global' ? 'Global instructions' : layer.role === 'repo' ? 'Repo instructions' : `Instructions (${layer.role})`,
            source: layer.filePath,
            reasonIncluded: 'Durable instruction layer',
            estimatedTokens: layer.tokenEstimate,
            removable: true,
          });
        }
      }

      // Editable files (selected context)
      for (const c of envelope.editable.slice(0, 8)) {
        ctxItems.push({
          id: `file:${c.id}`,
          itemType: 'file',
          label: c.path ? c.path.split(/[\\/]/).pop() ?? c.path : c.id,
          source: c.path ?? c.id,
          reasonIncluded: c.reasons[0] ?? 'Editable context',
          estimatedTokens: c.tokenEstimate,
          removable: true,
        });
      }

      // Reference files
      for (const c of envelope.reference.slice(0, 4)) {
        ctxItems.push({
          id: `ref:${c.id}`,
          itemType: 'reference',
          label: c.path ? c.path.split(/[\\/]/).pop() ?? c.path : c.id,
          source: c.path ?? c.id,
          reasonIncluded: c.reasons[0] ?? 'Reference context',
          estimatedTokens: c.tokenEstimate,
          removable: true,
        });
      }

      // Active checkpoint
      if (this.currentCheckpointId) {
        ctxItems.push({ id: `cp:${this.currentCheckpointId}`, itemType: 'checkpoint', label: `Checkpoint ${this.currentCheckpointId.slice(0, 8)}`, source: 'git', reasonIncluded: 'Latest checkpoint', removable: false });
      }

      onContextUpdate(ctxItems, tokenHealth);
    }

    // Hard-cap fullSystem to leave headroom for conversation history and tools.
    // Keeps the total request under the rate-limit ceiling (safeInputTokens).
    const systemBudget = Math.floor(safeInputTokens * 0.6);
    const systemTokenEstimate = estimateTokens(fullSystem);
    if (systemTokenEstimate > systemBudget) {
      const charsPerToken = 4;
      fullSystem =
        fullSystem.slice(0, systemBudget * charsPerToken) +
        '\n\n[System prompt truncated to fit rate limit budget]';
      onThought({
        type: 'thinking',
        label: `System prompt trimmed: ~${systemTokenEstimate} → ~${systemBudget} tokens (rate limit: ${safeInputTokens})`,
        timestamp: new Date(),
      });
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

    // Inject artifact registry so the model knows what files already exist from
    // previous sessions (e.g. a plan written in plan mode, readable in code mode).
    const [artifactNote, registeredArtifactPaths] = await Promise.all([
      this.loadArtifactRegistryNote(),
      this.loadArtifactPaths(),
    ]);
    if (artifactNote) {
      messages.push({ role: 'system', content: artifactNote });
    }

    // ─── Structured execution state ──────────────────────────────────────────
    // Load or create compact task state so the model has a structured summary of
    // what has been done, what files exist, and what to do next — without needing
    // to replay raw transcript narration.
    const stateManager = new ExecutionStateManager(this.workspaceRoot);
    let execState: ExecutionStateData = await stateManager.load(agentId) ??
      stateManager.createFresh(agentId, userMessage.slice(0, 500), mode);
    const stateNote = stateManager.buildContextNote(execState);
    messages.push({ role: 'system', content: stateNote });

    // ─── #16 Greenfield repo detector ────────────────────────────────────────
    // Classify the workspace maturity and inject a short guidance note so the
    // model knows whether to scaffold from scratch or build on existing files.
    const wsType = await this.detectWorkspaceType();
    messages.push({ role: 'system', content: this.buildWorkspaceTypeNote(wsType) });

    // ─── Continue contract ────────────────────────────────────────────────────
    // When the user says "continue" / "proceed", skip generic rediscovery and
    // resume from the first pending action in the execution state.
    const CONTINUE_PATTERN = /^\s*(continu[ei]|proceed|keep going|go on|go ahead|resume)\s*[.!]?\s*$/i;
    const effectiveUserContent =
      CONTINUE_PATTERN.test(userMessage) && execState.nextActions.length > 0
        ? `Continue from where you stopped. Next pending action: ${execState.nextActions[0]}`
        : userMessage;

    const userMsg: ChatMessage = { role: 'user', content: effectiveUserContent };
    messages.push(userMsg);
    // Defer adding to persistent session history until after a successful response.
    // Adding eagerly causes the message to strand in history when the session fails
    // with no output, leading to duplicate user messages on the next invocation.

    const rawTools = [...this.mcpHost.getAllTools(), ...getAppData().virtualTools];
    const tools = minifyToolDefinitions(rawTools);

    if (enhancedPipeline && this.currentCheckpointId) {
      messages.push({ role: 'system', content: `[System Notice]: A Git Checkpoint was successfully created before this task began (ID: ${this.currentCheckpointId}).` });
    }

    // Hard trim history to enforce the maxTokens rate-limit ceiling.
    // Drop oldest non-system turns until the total estimated token count fits.
    {
      const rateLimitCeiling = Math.floor(safeInputTokens * 0.85);
      const totalEst = estimateTokens(messages.map(m => m.content).join(' '));
      if (totalEst > rateLimitCeiling) {
        let removed = 0;
        // Find first non-system message index (skip the system prompt at index 0).
        let i = 1;
        while (i < messages.length - 1 && estimateTokens(messages.map(m => m.content).join(' ')) > rateLimitCeiling) {
          if (messages[i].role !== 'system') {
            messages.splice(i, 1);
            removed++;
          } else {
            i++;
          }
        }
        if (removed > 0) {
          onThought({
            type: 'thinking',
            label: `History trimmed: dropped ${removed} oldest turn(s) to fit rate limit (${safeInputTokens} tokens)`,
            timestamp: new Date(),
          });
        }
      }
    }

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
      const preservedItems: string[] = [];
      if (compactionResult.structured.currentObjective) preservedItems.push('objective');
      if (compactionResult.structured.decisions?.length) preservedItems.push('decisions');
      if (compactionResult.structured.recentArtifacts?.length) preservedItems.push('artifacts');
      if (compactionResult.structured.pendingNextSteps?.length) preservedItems.push('next steps');
      onCompaction?.(compactionResult.droppedMessages, preservedItems);

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
      8000,
      vsConfig.get<number>('maxOutputTokens', 8000)
    );

    let fullResponse = '';
    let lastAssistantText = ''; // text from the final iteration only (used for clean history storage)
    const toolsUsed: string[] = [];
    // Tracks paths written via write_file in this task so we can inject a system
    // constraint after each write — the model ignores [USER]-role reminders entirely.
    const writtenPaths = new Set<string>();
    let continueLoop = true;
    let isFirstModelRequest = true;
    let iterationCount = 0;
    const maxToolIterations = vsConfig.get<number>('agent.maxToolIterations', 20);
    // #6 — Discovery budget: track consecutive read-only calls with no writes.
    let consecutiveReadCount = 0;
    // #15 — Milestone stopping: pause the session every N writes so the agent
    // does not attempt to scaffold an entire project in one run.
    const milestoneWriteSize = vsConfig.get<number>('agent.milestoneWriteSize', 8);
    let nextMilestoneAt = milestoneWriteSize;

    while (continueLoop) {
      continueLoop = false;
      let calledATool = false;
      // Accumulate the model's text output for the current turn so we can add
      // a proper assistant turn to messages before each tool result. Without this,
      // the model cannot see its own prior tool calls and rewrites files repeatedly.
      let turnAssistantText = '';

      agentLog.logApiCall(iterationCount + 1, messages);
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

      for await (const event of provider.stream(messages, tools, actualMaxOutputTokens)) {
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
          agentLog.logTokenUsage(
            iterationCount + 1,
            event.usage.inputTokens,
            event.usage.outputTokens,
            event.usage.cacheReadInputTokens ?? 0,
            event.usage.cacheCreationInputTokens ?? 0
          );
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
          // Strip Gemini internal thinking-mode tokens that leak through as plain text.
          const cleanDelta = event.delta.replace(/<｜(?:begin|end)▁of▁thinking｜>/g, '');
          onText(cleanDelta);
          fullResponse += cleanDelta;
          turnAssistantText += cleanDelta;
        } else if (event.type === 'tool_use') {
          toolsUsed.push(event.name);
          agentLog.logToolCall(event.name, event.input);
          // Insert the assistant turn before the tool result so the model can see
          // its own prior tool calls on the next iteration and won't rewrite files.
          // For file-write/edit tools, include the path and content size so the model
          // knows exactly what it wrote and does not produce a second write to the same path.
          const toolCallPath = (event.input as Record<string, unknown>)?.path as string | undefined;
          const toolCallContent = (event.input as Record<string, unknown>)?.content as string | undefined;
          let assistantTurnLabel: string;
          if (toolCallPath && (event.name === 'write_file' || event.name === 'edit_file')) {
            const sizeNote = toolCallContent ? ` (${toolCallContent.length} chars)` : '';
            assistantTurnLabel = `[${event.name}: ${toolCallPath}${sizeNote}]`;
          } else {
            // Encode as a null-byte-delimited marker so GeminiProvider can convert
            // this into a native functionCall part.  The model never emits null bytes
            // so it cannot reproduce this format as plain text output.
            const argsJson = JSON.stringify(event.input ?? {});
            assistantTurnLabel = `\x00TOOL:${event.name}:${argsJson}\x00`;
          }
          messages.push({ role: 'assistant', content: turnAssistantText || assistantTurnLabel });
          turnAssistantText = '';

          // ─── Hard-enforce write_file uniqueness ──────────────────────────────
          // Text-based CONSTRAINT hints are ignored by Gemini after repeated exposure.
          // Instead, intercept rewrite attempts in code and return a rejection so the
          // model is forced to use edit_file rather than looping forever.
          const isFileWrite = event.name === 'write_file';
          let toolResultContent: string;
          if (isFileWrite && toolCallPath && writtenPaths.has(toolCallPath)) {
            const pathList = Array.from(writtenPaths).map(p => `"${p}"`).join(', ');
            const rejection = `[SYSTEM ERROR] write_file REJECTED: "${toolCallPath}" was already written this task. The file has NOT been changed. You MUST use edit_file for any corrections to existing files. Written paths: ${pathList}. Proceed with remaining tasks or summarise.`;
            agentLog.logToolResult(event.name, rejection);
            turnMemory.addToolResult(event.name, rejection);
            toolResultContent = `[Tool result: ${event.name}]\n${rejection}`;
            onThought({ type: 'error', label: `Rewrite blocked: ${toolCallPath}`, detail: rejection, timestamp: new Date() });
          } else if (isFileWrite && toolCallPath && registeredArtifactPaths.has(this.normalizeWorkspacePath(toolCallPath))) {
            // ─── Cross-session artifact guard ────────────────────────────────
            // File was created in a PREVIOUS session. Prevent silent re-creation
            // that discards prior work. Force the model to use edit_file instead.
            const normalizedGuard = this.normalizeWorkspacePath(toolCallPath);
            const rejection = `[SYSTEM ERROR] write_file REJECTED: "${normalizedGuard}" already exists from a previous session (artifact registry). The file has NOT been changed. Use edit_file to modify it, or read it first to see what was already written.`;
            agentLog.logToolResult(event.name, rejection);
            turnMemory.addToolResult(event.name, rejection);
            toolResultContent = `[Tool result: ${event.name}]\n${rejection}`;
            onThought({ type: 'error', label: `Cross-session artifact guard: ${normalizedGuard}`, detail: rejection, timestamp: new Date() });
          } else if (event.name === 'update_task_state') {
            // ─── In-process execution state update ───────────────────────────
            // Handled directly here so the agent can write back to the state
            // without needing a separate MCP server.
            const updates = event.input as {
              completed_step?: string;
              next_actions?: string[];
              blockers?: string[];
              tech_stack?: Record<string, string>;
            };
            if (updates.completed_step) {
              execState.completedSteps.push(updates.completed_step);
            }
            if (updates.next_actions !== undefined) {
              execState.nextActions = updates.next_actions;
            }
            if (updates.blockers !== undefined) {
              execState.blockers = updates.blockers;
            }
            if (updates.tech_stack) {
              execState.techStack = { ...execState.techStack, ...updates.tech_stack };
            }
            // Save immediately so the state is durable even if max-iterations hit
            stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
            const summary = [
              updates.completed_step ? `completed_step recorded` : '',
              updates.next_actions !== undefined ? `next_actions: ${execState.nextActions.length}` : '',
              updates.tech_stack ? `tech_stack: ${JSON.stringify(execState.techStack)}` : '',
            ].filter(Boolean).join(', ');
            agentLog.logToolResult(event.name, summary);
            toolResultContent = `[Task state updated — ${summary}]`;
          } else {
            const toolResult = await this.toolDispatcher.dispatch(
              event, agentId, onApproval, onDiff, onThought
            );
            agentLog.logToolResult(event.name, String(toolResult));
            turnMemory.addToolResult(event.name, String(toolResult));
            // Track read_file inputs in execution state to enforce the no-re-read rule
            if (event.name === 'read_file' && toolCallPath) {
              const normalizedInput = this.normalizeWorkspacePath(toolCallPath);
              if (!execState.resolvedInputs.includes(normalizedInput)) {
                execState.resolvedInputs.push(normalizedInput);
              }
            }
            // Truncate very large tool results so they don't dominate the context
            // window on subsequent iterations and cause the model to output tiny
            // narrations instead of the next tool call.
            const resultStr = String(toolResult);
            const MAX_TOOL_RESULT_CHARS = 8000;
            const truncatedResult = resultStr.length > MAX_TOOL_RESULT_CHARS
              ? resultStr.slice(0, MAX_TOOL_RESULT_CHARS) +
                `\n\n[... result truncated: ${resultStr.length - MAX_TOOL_RESULT_CHARS} more chars omitted from history ...]`
              : resultStr;
            toolResultContent = `[Tool result: ${event.name}]\n${truncatedResult}`;

            // ─── #6 Discovery budget enforcement ─────────────────────────────
            // Count consecutive reads with no writes. After 3+, inject a hard
            // nudge so the model stops rediscovering and starts implementing.
            const isReadOnlyTool = ['read_file', 'list_files', 'search_files'].includes(event.name);
            const isWriteOrActionTool = ['write_file', 'edit_file', 'run_command'].includes(event.name);
            if (isReadOnlyTool) {
              consecutiveReadCount++;
            } else if (isWriteOrActionTool) {
              consecutiveReadCount = 0;
            }
            if (consecutiveReadCount >= 3 && writtenPaths.size === 0) {
              toolResultContent += `\n\n[Discovery Budget] ${consecutiveReadCount} consecutive reads with nothing written yet. Stop reading — write your first file now.`;
            }

            if (isFileWrite && toolCallPath && String(toolResult).startsWith('File written')) {
              writtenPaths.add(toolCallPath);
              const pathList = Array.from(writtenPaths).map(p => `"${p}"`).join(', ');
              toolResultContent += `\n\nFiles written this task: ${pathList}. Use edit_file for any corrections to these paths.`;
              // Record in cross-session artifact registry so future sessions (e.g. code mode
              // after plan mode) know what files were created and where.
              this.recordArtifact(agentId, toolCallPath).catch(() => { /* non-fatal */ });
              // Update execution state with newly created artifact
              const normalizedArtifact = this.normalizeWorkspacePath(toolCallPath);
              if (!execState.artifactsCreated.includes(normalizedArtifact)) {
                execState.artifactsCreated.push(normalizedArtifact);
              }
              // Verify all written files are still on disk every 5 writes
              if (writtenPaths.size % 5 === 0) {
                const missingFiles = await this.verifyWrittenFiles(Array.from(writtenPaths));
                if (missingFiles.length > 0) {
                  toolResultContent += `\n\n[Verification] Warning: ${missingFiles.length} file(s) appear missing from disk: ${missingFiles.join(', ')}. Investigate before continuing.`;
                }
              }
            }
          }
          messages.push({ role: 'user', content: toolResultContent });
          calledATool = true;
          continueLoop = true;
          // ─── Phase-5: after-edit hook for file-mutation tools ──────────────
          if (enhancedPipeline && (event.name.includes('write') || event.name.includes('edit'))) {
            await this.hookEngine.onAfterEdit([event.name], { mode });

            // Post-Edit Pipeline (FR-021)
            onThought({ type: 'thinking', label: 'Running Validation Services...', timestamp: new Date() });
            const val = await this.validationService.run([event.name]);
            if (!val.ok) {
              onThought({
                type: 'error',
                label: `Validation Failed after edit (${val.diagnostics.length} issues)`,
                detail: val.diagnostics[0]?.message || 'Unknown Failure',
                timestamp: new Date()
              });
              // Provide context back to the agent so it can self-repair (FR-057)
              messages.push({ role: 'user', content: `[Validation Output]\n${val.rawOutput}\nPlease fix the errors before continuing.` });
            } else {
              this.currentCheckpointId = null; // Prepare for next checkpoint
            }
          }
        }
      }

      // ─── #15 Phase-level milestone stopping ──────────────────────────────────
      // Pause every `milestoneWriteSize` writes so the agent presents progress
      // before continuing to scaffold more files. The user types "continue" to resume.
      if (continueLoop && milestoneWriteSize > 0 && writtenPaths.size >= nextMilestoneAt) {
        const written = Array.from(writtenPaths);
        const milestoneSummary =
          `Milestone reached: ${writtenPaths.size} file(s) written this session — ` +
          `${written.slice(0, 6).join(', ')}${written.length > 6 ? ` and ${written.length - 6} more` : ''}. ` +
          `Session paused for review. Type "continue" to resume.`;
        onThought({
          type: 'thinking',
          label: `Milestone stop at ${writtenPaths.size} writes (threshold: ${nextMilestoneAt})`,
          detail: milestoneSummary,
          timestamp: new Date(),
        });
        onText(`\n\n[Milestone] ${milestoneSummary}`);
        lastAssistantText = milestoneSummary;
        continueLoop = false;
        nextMilestoneAt += milestoneWriteSize;
      }

      // Capture the text from this iteration so the final persist stores only the
      // last summary, not a concatenation of every iteration's text output.
      if (turnAssistantText) {
        lastAssistantText = turnAssistantText;
      }

      iterationCount++;
      if (iterationCount >= maxToolIterations) {
        onThought({
          type: 'error',
          label: `Max tool iterations reached (${maxToolIterations})`,
          detail: 'The agent exceeded the maximum allowed tool iterations for a single request. Forcing loop exit to prevent runaway orchestration.',
          timestamp: new Date()
        });
        continueLoop = false;
        const systemNote = `\n\n[System]: The agent exceeded the maximum allowed tool iterations (${maxToolIterations}) and the operation was terminated early to prevent an infinite loop.`;
        fullResponse += systemNote;
        // Replace lastAssistantText with a clean progress summary so the session
        // history is not polluted with the full concatenation of all narrations.
        // The summary tells the next session exactly what was accomplished.
        if (writtenPaths.size > 0) {
          const written = Array.from(writtenPaths);
          lastAssistantText = `Progress checkpoint: completed ${written.length} file(s) in this session — ${written.slice(0, 8).join(', ')}${written.length > 8 ? `, ... and ${written.length - 8} more` : ''}. Session paused at the tool iteration limit; continue to resume implementation.`;
        } else {
          lastAssistantText = `Session paused at tool iteration limit after ${toolsUsed.length} operations. Continue to resume.`;
        }
      }

      if (!calledATool) {
        // If the model narrated intent to call a tool (e.g. "Now let me read X:")
        // but emitted no function call, push a recovery nudge and re-enter the loop.
        // This happens when a huge tool result floods the context and the model "runs
        // out of steam", outputting a short narration instead of the next call.
        if (toolsUsed.length > 0 && iterationCount < maxToolIterations) {
          const checkText = (turnAssistantText || lastAssistantText).trim();
          const isNarratingNextCall =
            checkText.endsWith(':') ||
            checkText.endsWith('...') ||
            /\b(let me|i['']ll now|now let me|i will now)\s+(read|check|list|examine|look at|search|write|run|create)\b/i.test(checkText);
          if (isNarratingNextCall) {
            onThought({
              type: 'thinking',
              label: 'Narration-without-action detected — nudging model to execute',
              detail: `Model said "${checkText.slice(-120)}" but called no tool`,
              timestamp: new Date(),
            });
            if (turnAssistantText) {
              messages.push({ role: 'assistant', content: turnAssistantText });
              turnAssistantText = '';
            }
            messages.push({ role: 'user', content: 'Call the next tool now. Do not narrate — execute immediately.' });
            continueLoop = true;
          }
        }
        if (!continueLoop) {
          continueLoop = false;
        }
      }
    }

    // ─── Degenerate response guard ────────────────────────────────────────────
    // Gemini sometimes outputs a tool-call label as plain text instead of a proper
    // function_call. When detected, inject one final synthesis prompt (no tools) to
    // force a real text answer.
    {
      const lastText = (lastAssistantText || fullResponse).trim();
      const looksDegenerate =
        lastText === '' ||
        lastText === '▶' ||
        lastText.startsWith('\x00TOOL:') ||
        /^<tool:\w[^>]*>\s*$/.test(lastText) ||
        /^\[(?:calling|tool:)\s*\w[^\]]*\]\s*$/.test(lastText);
      if (looksDegenerate && toolsUsed.length > 0 && iterationCount < maxToolIterations) {
        onThought({
          type: 'thinking',
          label: 'Degenerate response detected — injecting synthesis prompt',
          detail: `Last model output was ${lastText.length ? `"${lastText}"` : '(empty)'} after ${toolsUsed.length} tool calls`,
          timestamp: new Date(),
        });
        // Use a lean context for synthesis — the full messages array may be too large
        // after many tool iterations, causing the model to return 0 tokens again.
        const synthesisMessages: ChatMessage[] = [
          messages[0], // system prompt only
          { role: 'user', content: `You have completed ${toolsUsed.length} tool operations for the following request: "${userMessage}"\n\nPlease now provide your complete final answer as plain text. Do not call any tools. Summarise what you did and what the outcome was.` },
        ];
        let synthText = '';
        for await (const synthEvent of provider.stream(synthesisMessages, [], actualMaxOutputTokens)) {
          if (synthEvent.type === 'text') {
            onText(synthEvent.delta);
            synthText += synthEvent.delta;
          } else if (synthEvent.type === 'token_usage') {
            onTokenUsage?.(synthEvent.usage);
          }
        }
        if (synthText.trim()) {
          fullResponse = synthText;
          lastAssistantText = synthText;
        }
      }
    }

    // Final safety net: the loop produced no text at all — always show something.
    if (!fullResponse.trim()) {
      const fallback = 'The agent completed tool operations but did not generate a text response. Please try your request again.';
      onText(fallback);
      fullResponse = fallback;
      lastAssistantText = fallback;
    }

    // Persist completed turn.
    // Skip storing provider error messages (e.g. "Gemini returned an empty response")
    // as assistant turns — they would pollute session history on the next invocation.
    const isProviderError = fullResponse.includes('returned an empty response') ||
      fullResponse.includes('finish reason:');
    // Skip storing narration-only sessions — if the final text is just the model
    // describing its next intended action (e.g. "Let me read X..."), saving it to
    // history would cause the next session to re-derive the same context instead of
    // picking up real progress.
    const finalText = (lastAssistantText || fullResponse).trim();
    const isIncompleteNarration =
      toolsUsed.length > 0 &&
      finalText.length < 300 &&
      (/\b(let me|i['']ll now|now let me|i will now)\s+(read|check|list|examine|look at|search|write|run|create)\b/i.test(finalText) ||
        finalText.endsWith(':') ||
        finalText.endsWith('...'));
    if (fullResponse && !isProviderError && !isIncompleteNarration) {
      agentLog.logModelText(fullResponse);
      // Persist user message first so history always has matching user/assistant pairs.
      this.memoryManager.addMessage(agentId, userMsg);
      // Store only the final text segment (not the full concatenation of all
      // iterations) so history does not contain duplicate summaries.
      const assistantMsg: ChatMessage = { role: 'assistant', content: lastAssistantText || fullResponse };
      this.memoryManager.addMessage(agentId, assistantMsg);
      await this.memoryManager.persistTurn(agentId, userMessage, fullResponse, toolsUsed);

      // Update enhanced session memory with the files touched this turn.
      for (const file of toolsUsed.filter(t => t.includes('write') || t.includes('edit'))) {
        this.enhancedMemory.recordEditedFile(agentId, file);
      }
      await this.enhancedMemory.persistState(agentId);

      // Phase 3: Commit Proposal (FR-032)
      const editedTools = toolsUsed.filter(t => t.includes('write') || t.includes('edit'));
      if (enhancedPipeline && editedTools.length > 0) {
        const proposal = await this.commitGenerator.generate(this.workspaceRoot, fullResponse.substring(0, 500));
        onThought({
          type: 'thinking',
          label: `Proposed Commit: ${proposal.title}`,
          detail: proposal.body,
          timestamp: new Date()
        });
        // Emit diff summary for 2+ changed files (OQ-8 B)
        if (editedTools.length >= 2) {
          onDiffSummary?.(editedTools, proposal.title, this.currentCheckpointId ?? undefined);
        }
      }

      // Phase 4: Sandbox Promotion Prompt
      if (this.sandboxManager && this.activeSandbox) {
        const mutationTools = ['write_file', 'edit_file', 'run_command', 'git_commit', 'create_document', 'create_presentation'];
        const hasMutations = toolsUsed.some(t => mutationTools.includes(t));

        if (hasMutations) {
          const promote = await onApproval(`The agent has modified files in its sandbox. Would you like to apply these changes to your workspace?`);
          if (promote) {
            onThought({ type: 'thinking', label: 'Applying sandbox changes to workspace...', timestamp: new Date() });
            try {
              await this.sandboxManager.promote(this.activeSandbox.sandboxId);
              onThought({ type: 'thinking', label: 'Sandbox changes applied successfully.', timestamp: new Date() });
            } catch (err: any) {
              onThought({ type: 'error', label: 'Failed to apply sandbox changes', detail: err.message, timestamp: new Date() });
            }
          } else {
            onThought({ type: 'thinking', label: 'User declined to apply sandbox changes.', timestamp: new Date() });
          }
        }
      }

      // Save a session checkpoint so the session can be resumed after restart.
      await saveCheckpoint(this.workspaceRoot, buildCheckpointState(requestId, {
        activeMode: mode,
        currentPlan: this.enhancedMemory.getState(agentId).currentPlan,
        recentEditedFiles: this.enhancedMemory.getState(agentId).recentEditedFiles,
        pendingToolArtifacts: toolsUsed,
      }));

      agentLog.sessionEnd(toolsUsed);

      // End turn and extract semantic memories
      turnMemory.endTurn();
      if (this.consolidator) {
        try {
          await this.consolidator.consolidateSession(agentId, requestId, turnMemory);
        } catch (err) {
          console.warn(`AgentRunner: Failed to consolidate semantic memory for ${agentId}:`, err);
        }
      }
    }

    // Always save execution state — even for incomplete sessions — so the
    // continue contract can resume from the last known position next invocation.
    execState.iterationsUsed += iterationCount;
    execState.mode = mode;
    execState.updatedAt = new Date().toISOString();
    stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
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

  // ─── Path utilities ───────────────────────────────────────────────────────

  /** Strip leading slashes so "/foo/bar.ts" → "foo/bar.ts" (workspace-relative). */
  private normalizeWorkspacePath(input: string): string {
    return input.replace(/^[/\\]+/, '');
  }

  /**
   * Check which of the given paths are missing from disk.
   * Used by the write-then-verify gate to catch silent write failures early.
   */
  private async verifyWrittenFiles(paths: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const filePath of paths) {
      try {
        await fs.access(path.resolve(this.workspaceRoot, filePath));
      } catch {
        missing.push(filePath);
      }
    }
    return missing;
  }

  // ─── Artifact registry ────────────────────────────────────────────────────
  // Tracks files created across sessions so mode transitions (plan → code) can
  // inject a "files already created" note into the next session's context.

  private artifactRegistryPath(): string {
    return path.join(this.workspaceRoot, '.bormagi', 'artifact-registry.json');
  }

  private async recordArtifact(agentId: string, filePath: string): Promise<void> {
    const normalizedPath = this.normalizeWorkspacePath(filePath);
    const registryPath = this.artifactRegistryPath();
    let entries: Array<{ agentId: string; path: string; timestamp: string }> = [];
    try {
      const raw = await fs.readFile(registryPath, 'utf8');
      entries = JSON.parse(raw);
    } catch { /* first run or corrupt — start fresh */ }
    // Avoid duplicate entries for the same path
    if (!entries.some(e => e.path === normalizedPath)) {
      entries.push({ agentId, path: normalizedPath, timestamp: new Date().toISOString() });
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, JSON.stringify(entries, null, 2), 'utf8');
    }
  }

  /** Returns the set of normalized paths stored in the artifact registry. */
  async loadArtifactPaths(): Promise<Set<string>> {
    try {
      const raw = await fs.readFile(this.artifactRegistryPath(), 'utf8');
      const entries: Array<{ path: string }> = JSON.parse(raw);
      return new Set(entries.map(e => this.normalizeWorkspacePath(e.path)));
    } catch {
      return new Set();
    }
  }

  async loadArtifactRegistryNote(): Promise<string> {
    try {
      const raw = await fs.readFile(this.artifactRegistryPath(), 'utf8');
      const entries: Array<{ agentId: string; path: string; timestamp: string }> = JSON.parse(raw);
      if (entries.length === 0) { return ''; }
      const lines = entries.map(e => `- ${e.path} (created by ${e.agentId})`).join('\n');
      return `[Artifact Registry — files created in previous sessions]\n${lines}\n\nBefore writing any file, check if it already exists at one of these paths.`;
    } catch {
      return '';
    }
  }

  // ─── #16 Greenfield repo detector ─────────────────────────────────────────

  /**
   * Classify workspace maturity based on file count and key project files.
   * Returns 'greenfield' for empty repos, 'scaffolded' for basic skeletons,
   * and 'mature' for established codebases.
   */
  private async detectWorkspaceType(): Promise<'greenfield' | 'scaffolded' | 'mature'> {
    try {
      const entries = await fs.readdir(this.workspaceRoot);
      const hasPackageJson = entries.includes('package.json');
      const hasSrc = entries.includes('src');
      // Exclude hidden dirs and node_modules from maturity count
      const nonHidden = entries.filter(e => !e.startsWith('.') && e !== 'node_modules');
      if (nonHidden.length <= 2 && !hasPackageJson) {
        return 'greenfield';
      }
      if (hasPackageJson && !hasSrc && nonHidden.length < 8) {
        return 'scaffolded';
      }
      return 'mature';
    } catch {
      return 'mature'; // safe default: assume existing work is present
    }
  }

  /** Return a short system note describing workspace maturity to the model. */
  private buildWorkspaceTypeNote(wsType: 'greenfield' | 'scaffolded' | 'mature'): string {
    if (wsType === 'greenfield') {
      return '[Workspace: Greenfield] No project files detected. Start by creating a project structure (package.json, src/, README.md) before adding application code.';
    }
    if (wsType === 'scaffolded') {
      return '[Workspace: Scaffolded] Basic project structure exists but is not yet mature. Build on the existing scaffolding rather than replacing it.';
    }
    return '[Workspace: Mature] Existing codebase detected. Read key files before modifying. Prefer edit_file over write_file for files that may already exist.';
  }
}
