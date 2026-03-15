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
import { ChatMessage, TokenUsage, MCPToolDefinition } from '../types';
import type { AgentExecutionResult } from '../workflow/types';
import { ExecutionOutcome } from '../workflow/enums';
import { scanForSecrets, trimToContextLimit } from './execution/ContextWindow';
import { parseStructuredCompletion, sanitiseExecutionResult } from './execution/CompletionParser';
import { ToolDispatcher, type DispatchResult } from './execution/ToolDispatcher';
import {
  buildRepoSummary,
  formatRelevantContext,
  measureRequestSize,
  minifyToolDefinitions,
  selectRelevantFileSnippets
} from './execution/PromptEfficiency';
import type { ApprovalCallback, DiffCallback, ThoughtCallback } from './execution/ToolDispatcher';
import { buildExecutionHistory } from './execution/ExecutionHistoryReducer';
import { sanitiseCodeModeNarration } from './execution/TranscriptSanitiser';
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
import { ExecutionStateManager, type ExecutionStateData, type SessionPhase, type ResolvedInputSummary } from './ExecutionStateManager';
import { DISCOVERY_TOOLS, MUTATION_TOOLS } from './execution/ExecutionPhase';
import { inferStepContract } from './execution/StepContract';
import { classifyTask } from './execution/TaskClassifier';
import { TASK_TEMPLATES, TEMPLATE_SKILL_MAP } from './execution/TaskTemplate';
import { ConsistencyValidator } from './execution/ConsistencyValidator';
import { MilestoneFinalizer } from './execution/MilestoneFinalizer';
import { BatchEnforcer } from './execution/BatchEnforcer';
import { ArchitectureLock } from './execution/ArchitectureLock';
import { sanitiseContent, sanitiseTranscript } from './execution/TranscriptSanitiser';
import { PromptAssembler, buildWorkspaceSummary, type PromptContext } from './execution/PromptAssembler';
import { RecoveryManager } from './execution/RecoveryManager';
import { FileSummaryStore } from './execution/FileSummaryStore';
import { ContextPacketBuilder } from './execution/ContextPacketBuilder';
import { ContextCostTracker } from './execution/ContextCostTracker';
import { ProgressGuard } from './execution/ProgressGuard';
import { classifyUserMessage } from './execution/ObjectiveNormalizer';

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

    const silentModeEnabled = vsConfig.get<boolean>('silentExecution', false);

    // V2: PromptAssembler builds compact, no-history messages for each LLM call in code mode.
    // Initialized here so it can be referenced throughout the run() method.
    const _paMsgs = getAppData().executionMessages as Record<string, unknown>;
    const _paSection = (_paMsgs.promptAssembly ?? {}) as Record<string, string>;
    const promptAssembler = new PromptAssembler({
      executionStateHeader: _paSection.executionStateHeader ?? '[Execution State — resume context]',
      workspaceHeader: _paSection.workspaceHeader ?? '[Workspace]',
      milestoneSummaryPrefix: _paSection.milestoneSummaryPrefix ?? 'Prior milestone: ',
    });

    // DD7: FileSummaryStore — hash-based file summary cache for reuse instead of re-reading.
    const fileSummaryStore = new FileSummaryStore();

    // DD7: ContextPacketBuilder — builds compact context packets from execution state.
    const contextPacketBuilder = new ContextPacketBuilder();

    // DD12: ContextCostTracker — per-turn token cost telemetry.
    const contextCostTracker = new ContextCostTracker();

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
    // V2: reset per-run guard state in ToolDispatcher (reread prevention + discovery budget)
    // Also initialise BatchEnforcer and ArchitectureLock for Phase 4 enforcement.
    const batchEnforcer = new BatchEnforcer(this.workspaceRoot);
    const archLock = new ArchitectureLock(
      this.workspaceRoot,
      getAppData().architecturePatterns
    );
    let detectedWorkspaceType: 'greenfield' | 'docs_only' | 'scaffolded' | 'mature' = 'mature';
    this.toolDispatcher.resetGuardState(mode, true);
    detectedWorkspaceType = await batchEnforcer.detectWorkspaceType();
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

    const bootstrapContext = ''; // kept for measureRequestSize compat — pipeline handles context
    const retrievalContext = ''; // kept for measureRequestSize compat — pipeline handles context

    // Inject artifact registry so the model knows what files already exist from
    // previous sessions (e.g. a plan written in plan mode, readable in code mode).
    const [artifactNote, registeredArtifactPaths] = await Promise.all([
      this.loadArtifactRegistryNote(),
      this.loadArtifactPaths(),
    ]);

    // ─── Structured execution state ──────────────────────────────────────────
    // Load or create compact task state so the model has a structured summary of
    // what has been done, what files exist, and what to do next — without needing
    // to replay raw transcript narration.
    const stateManager = new ExecutionStateManager(this.workspaceRoot);
    let execState: ExecutionStateData = await stateManager.load(agentId) ??
      stateManager.createFresh(agentId, userMessage.slice(0, 500), mode);

    // ─── Reconcile execution state with user message (Tasks 3 + 4) ────────────
    // For ALL new (non-continue) messages: reset task-scoped counters, objective,
    // and mode.  For continues: only refresh objective text.
    // Mode parameter ALWAYS wins — stored mode is never carried over.
    stateManager.reconcileWithUserMessage(execState, userMessage, mode);
    stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });

    // ─── Wire ToolDispatcher to authoritative execution state (Task 1) ────────
    this.toolDispatcher.setExecutionState(execState);

    // ─── Seed reread prevention from prior session ──────────────────────────────
    // Pre-populate the ToolDispatcher's read cache with files read in previous
    // sessions so the framework actually blocks re-reads (not just a prompt hint).
    if (execState.resolvedInputs && execState.resolvedInputs.length > 0) {
      this.toolDispatcher.seedReadCache(execState.resolvedInputs);
    }

    // ─── DD2 + DD10: Build messages array — code mode uses execution history, not raw transcript ──
    const stateNote = stateManager.buildContextNote(execState);
    const messages: ChatMessage[] = [
      { role: 'system', content: fullSystem },
    ];
    if (mode === 'code') {
      // DD2: Code mode gets only structured execution state + artifact registry.
      // Zero raw previous assistant narration to prevent loop-causing patterns.
      messages.push(...buildExecutionHistory(execState, stateNote, artifactNote || undefined));
    } else if (mode === 'ask') {
      // Ask mode gets full conversation history for continuity.
      messages.push(...sessionHistory);
      if (artifactNote) { messages.push({ role: 'system', content: artifactNote }); }
    } else {
      // Plan/review modes get artifact note + state note but no raw history.
      if (artifactNote) { messages.push({ role: 'system', content: artifactNote }); }
      messages.push({ role: 'system', content: stateNote });
    }

    // ─── DD10: Resolve approved plan path ────────────────────────────────────
    // If user switched to code mode and we have a plan artifact, mark it approved.
    if (mode === 'code' && !execState.approvedPlanPath) {
      const planPath = this.resolveApprovedPlanPath(execState, registeredArtifactPaths, userMessage);
      if (planPath) {
        stateManager.markPlanApproved(execState, planPath);
        stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
      }
    }

    // Phase 8.3 — Classify task template once at run start
    let activeTaskTemplate = execState.taskTemplate;
    if (!activeTaskTemplate) {
      activeTaskTemplate = classifyTask(userMessage, mode);
      execState.taskTemplate = activeTaskTemplate;
      stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
    }
    const activeSkills: string[] = activeTaskTemplate
      ? (TEMPLATE_SKILL_MAP[activeTaskTemplate] ?? [])
      : [];

    // Phase 0.1 — startup telemetry: confirms which engine path is active every run
    stateManager.setExecutionPhase(execState, 'INITIALISING');
    onThought?.({
      type: 'thinking',
      label: `[Runtime] engine=V2 | silent=${silentModeEnabled} | mode=${mode} | phase=${execState.runPhase ?? 'NEW'} | execPhase=${stateManager.getExecutionPhase(execState)} | iterations=${execState.iterationsUsed}${activeTaskTemplate ? ` | template=${activeTaskTemplate}` : ''}`,
      timestamp: new Date(),
    });
    if (activeTaskTemplate) {
      const tmpl = TASK_TEMPLATES[activeTaskTemplate];
      onThought?.({
        type: 'thinking',
        label: `[TaskTemplate] ${activeTaskTemplate} | requiresBatch=${tmpl.requiresBatch} | stopAfterWrite=${tmpl.stopAfterWrite ?? false}`,
        detail: tmpl.stopRules.join('; '),
        timestamp: new Date(),
      });
    }

    // ─── #16 Greenfield repo detector ────────────────────────────────────────
    // Classify the workspace maturity and inject a short guidance note so the
    // model knows whether to scaffold from scratch or build on existing files.
    // Task 7: Reuse batchEnforcer.detectWorkspaceType() (computed at line 361)
    // instead of the separate AgentRunner.detectWorkspaceType() heuristic.
    messages.push({ role: 'system', content: this.buildWorkspaceTypeNote(detectedWorkspaceType) });

    // detectedWsType is now the same as detectedWorkspaceType (unified source).
    const detectedWsType = detectedWorkspaceType;

    // V2: per-iteration tool results — reset each loop so PromptAssembler only sees
    // the CURRENT step's results, not the full replayed history.
    const currentStepToolResults: ChatMessage[] = [];

    // DD8: In code mode, `messages` serves as the audit transcript only — provider calls
    // are built fresh each iteration by PromptAssembler. Cap the audit transcript to
    // the most recent entries to prevent unbounded growth.
    const AUDIT_TRANSCRIPT_MAX = 20; // keep last N entries for recovery/narration checks

    // ─── Continue / nudge contract ──────────────────────────────────────────
    // When the user says "continue", "proceed", "why did you stop", etc. — skip
    // generic rediscovery and resume from the first pending action.
    // IMPORTANT: nudge messages like "why did you stop" must NOT replace the
    // primary objective — reconcileWithUserMessage now handles this.
    // Uses ObjectiveNormalizer (single source of truth) for intent classification.
    const messageIntent = classifyUserMessage(userMessage);
    const isContinueRequest = messageIntent === 'continue' || messageIntent === 'nudge';
    let effectiveUserContent = userMessage;
    let forceSilentOnResume = false;
    if (isContinueRequest) {
      // Increment continue counter for recovery trigger tracking
      execState.continueCount = (execState.continueCount ?? 0) + 1;
      execState.continueIterationSnapshot = execState.iterationsUsed;
      stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });

      // Phase 2: prefer structured nextToolCall for direct dispatch
      if (execState.nextToolCall) {
        const ntc = execState.nextToolCall;
        const label = ntc.description ?? ntc.tool;
        onText(`\n[Resuming: ${label}]\n\n`);
        // Dispatch the tool directly — no LLM call needed for resume
        contextCostTracker.recordSkippedLLMCall();
        try {
          const directResult = await this.toolDispatcher.dispatch(
            { id: `resume-${Date.now()}`, name: ntc.tool, input: ntc.input },
            agentId, onApproval, onDiff, onThought
          );
          stateManager.markToolExecuted(execState, ntc.tool, undefined, directResult.text.slice(0, 150));
          stateManager.clearNextToolCall(execState);
          stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
          // Continue with the result as the current user content
          const toolResultMsg: ChatMessage = { role: 'tool_result', content: directResult.text, toolCallId: `resume-${Date.now()}` };
          currentStepToolResults.push(toolResultMsg);
          messages.push(toolResultMsg);
          effectiveUserContent = `Resumed from nextToolCall: ${label}. Continue with the next step.`;
        } catch {
          // Fall back to text-based resume if direct dispatch fails
          effectiveUserContent = `Resume implementation. Next action: ${execState.nextActions[0] ?? 'continue'}. Do not re-read unchanged files.`;
        }
      } else if (execState.nextActions.length > 0) {
        const nextAction = execState.nextActions[0];
        const lastTool = execState.lastExecutedTool;
        const resumeSummary = lastTool
          ? `Resuming from last completed: ${lastTool} → Next: ${nextAction}`
          : `Resuming: ${nextAction}`;
        onText(`\n[${resumeSummary}]\n\n`);
        effectiveUserContent = lastTool
          ? `Resume implementation. Last completed: ${lastTool}. Next action: ${nextAction}. Do not re-read unchanged files.`
          : `Continue from where you stopped. Next pending action: ${nextAction}. Do not re-read unchanged files.`;
      } else {
        // Check for active batch with remaining files — use batch state as instruction
        const batchPlanned = execState.plannedFileBatch ?? [];
        const batchCompleted = execState.completedBatchFiles ?? [];
        const batchRemaining = batchPlanned.filter(f => !batchCompleted.includes(f));
        if (batchRemaining.length > 0) {
          const nextFile = batchRemaining[0];
          onText(`\n[Batch active: ${batchCompleted.length}/${batchPlanned.length} done — resuming with ${nextFile}]\n\n`);
          effectiveUserContent = `Continue with the active batch. Write the next batch file now: ${nextFile}. Generate the full file content. Do not re-read any files.`;
          forceSilentOnResume = true;
        } else {
          onText('\n[Cannot resume: next action is missing; rebuilding execution state.]\n\n');
          // Fall through with original message so the agent re-assesses
        }
      }
    }

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
    // Task 10: Track tool+path combinations to detect loops
    const toolPathCounts = new Map<string, number>();
    // Phase 5 — Recovery: limit how many times recovery can fire per run.
    // Without a cap, recovery → same trigger → recovery creates an infinite loop.
    let recoveryAttempts = 0;
    const MAX_RECOVERY_ATTEMPTS = 2;
    const maxToolIterations = vsConfig.get<number>('agent.maxToolIterations', 20);
    // #6 — Discovery budget: track consecutive read-only calls with no writes.
    let consecutiveReadCount = 0;
    // Task 2 — Track unique blocked read paths to avoid double-counting.
    const blockedReadPaths = new Set<string>();
    // Silent execution: suppress pure narration turns when model is stalling.
    // Triggered by phrases in the user message; per-run only, never persisted.
    const SILENT_TRIGGER_PATTERNS = [
      /do\s+not\s+narrate/i,
      /execute\s+immediately/i,
      /call\s+the\s+next\s+tool\s+now/i,
    ];
    let silentExecution =
      SILENT_TRIGGER_PATTERNS.some(p => p.test(userMessage)) || forceSilentOnResume;
    // V2 — Nudge retry cap: prevent infinite nudge loops (max 2 retries per run).
    let nudgeRetryCount = 0;
    const MAX_NUDGE_RETRIES = 2;
    // Phase 5.2 — Silent reprompt counter: max 2 reprompts before treating as blocked
    let silentRepromptCount = 0;
    const MAX_SILENT_REPROMPTS = 2;
    // Bug-fix004 item 15 — ProgressGuard: track productive vs non-productive turns
    const progressGuard = new ProgressGuard();
    // #15 — Milestone stopping: pause the session every N writes so the agent
    // does not attempt to scaffold an entire project in one run.
    const milestoneWriteSize = vsConfig.get<number>('agent.milestoneWriteSize', 8);
    let nextMilestoneAt = milestoneWriteSize;

    // Phase 4 — MilestoneFinalizer: deterministic per-step continue/wait/validate/complete
    const _mmSection = (getAppData().executionMessages.milestoneDecisions ?? {}) as Record<string, string>;
    const milestoneFinalizer = new MilestoneFinalizer({
      waitAutoDetected: _mmSection.waitAutoDetected ?? 'Deliverable written — pausing for your input.',
      batchCheckpoint: _mmSection.batchCheckpoint ?? 'Batch checkpoint reached — running validation.',
      batchComplete: _mmSection.batchComplete ?? 'All batch files written — validating output.',
    });

    // Virtual tools are handled in the streaming event handler, not by ToolDispatcher.
    // They must never be directly dispatched via bypass/DD9 — they'd fail with "Tool not found".
    const VIRTUAL_TOOLS = new Set(['declare_file_batch', 'update_task_state']);

    while (continueLoop) {
      // Phase 4: terminal state check — exit immediately if runPhase is no longer RUNNING
      if ((execState.runPhase ?? 'RUNNING') !== 'RUNNING') {
        const phase = execState.runPhase!;
        const tsMsgs = getAppData().executionMessages.terminalStates ?? {};
        const reason = execState.waitStateReason ?? '';
        let terminalMsg: string;
        switch (phase) {
          case 'WAITING_FOR_USER_INPUT':
            terminalMsg = (tsMsgs.waitingForUserInput ?? 'Paused — waiting for your input. {reason}').replace('{reason}', reason);
            break;
          case 'BLOCKED_BY_VALIDATION':
            terminalMsg = tsMsgs.blockedByValidation ?? 'Blocked — validation issues must be resolved before continuing.';
            break;
          case 'COMPLETED':
            terminalMsg = tsMsgs.sessionCompleted ?? 'Task completed.';
            break;
          case 'PARTIAL_BATCH_COMPLETE':
            terminalMsg = tsMsgs.partialBatchComplete ?? 'Batch phase complete. Resume when ready.';
            break;
          case 'RECOVERY_REQUIRED':
            terminalMsg = tsMsgs.recoveryRequired ?? 'Execution state is inconsistent. Recovery required — use bormagi.resetExecutionState to reset.';
            break;
          default:
            terminalMsg = `Session stopped (phase: ${phase}).`;
        }
        onText(`\n\n${terminalMsg}`);
        break;
      }

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

      // Phase 5: RecoveryManager — check all 5 triggers before each LLM call.
      // Skip if we've already exhausted recovery attempts for this run — prevents
      // infinite recovery loops where the same trigger fires every iteration.
      if (recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        const recoveryManager = new RecoveryManager(execState, messages, promptAssembler, fullSystem, detectedWsType, stateManager);
        const trigger = recoveryManager.shouldRecover();
        if (trigger) {
          recoveryAttempts++;
          const result = recoveryManager.rebuild(trigger);
          const recovMsgs = getAppData().executionMessages.recovery ?? {};
          if (result.success && result.cleanMessages) {
            onText(`\n${recovMsgs.rebuilding ?? 'Inconsistent execution state detected — rebuilding from execution history.'}\n`);
            messages.splice(0, messages.length, ...result.cleanMessages);
            // Reset reread-prevention state so the agent can re-read files it needs
            // after the context has been rebuilt without their content.
            this.toolDispatcher.resetGuardState(mode, true);
            // Reset recovery-related counters so they don't immediately re-trigger.
            execState.blockedReadCount = 0;
            execState.continueCount = 0;
            consecutiveReadCount = 0;
            blockedReadPaths.clear();

            // ─── Task 2: Hard strategy switch on blocked rereads ───────────────
            // After REPEATED_BLOCKED_READS recovery: force a deterministic next
            // step instead of letting the LLM loop back into reads.
            if (trigger === 'REPEATED_BLOCKED_READS') {
              // DD9: Try deterministic next step first
              const deterministicStep = stateManager.computeDeterministicNextStep(execState, detectedWsType);
              const nextToolCall = deterministicStep?.nextToolCall ?? execState.nextToolCall;
              if (nextToolCall && !VIRTUAL_TOOLS.has(nextToolCall.tool)) {
                // Direct dispatch — skip LLM call entirely
                contextCostTracker.recordSkippedLLMCall();
                const ntc = nextToolCall;
                onThought?.({ type: 'thinking', label: `[Strategy switch] Dispatching deterministic nextToolCall: ${ntc.tool}`, timestamp: new Date() });
                const directResult = await this.toolDispatcher.dispatch(
                  { id: `strategy-${Date.now()}`, name: ntc.tool, input: ntc.input as Record<string, unknown> },
                  agentId, onApproval, onDiff, onThought
                );
                stateManager.markToolExecuted(execState, ntc.tool, (ntc.input as Record<string, unknown>).path as string | undefined, directResult.text.slice(0, 150));
                stateManager.clearNextToolCall(execState);
                stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
                const truncDirect = directResult.text.length > 8000 ? directResult.text.slice(0, 8000) + '\n[truncated]' : directResult.text;
                messages.push({ role: 'tool_result', content: `<tool_result name="${ntc.tool}">\n${truncDirect}\n</tool_result>` });
                currentStepToolResults.push({ role: 'tool_result', content: `<tool_result name="${ntc.tool}">\n${truncDirect}\n</tool_result>` });
              } else if (execState.nextActions.length > 0) {
                // Use first nextAction as the instruction for the next LLM call
                effectiveUserContent = execState.nextActions[0];
                onThought?.({ type: 'thinking', label: `[Strategy switch] Using nextAction as instruction: ${effectiveUserContent.slice(0, 100)}`, timestamp: new Date() });
              } else {
                // Use deterministic step from DD5 or fall back to advisory computeNextStep
                const hint = deterministicStep ?? stateManager.computeNextStep(execState, execState.lastExecutedTool ?? 'none', undefined, '', detectedWsType);
                if (hint) {
                  effectiveUserContent = hint.nextAction;
                  if (hint.nextToolCall && !VIRTUAL_TOOLS.has(hint.nextToolCall.tool)) { stateManager.setNextToolCall(execState, hint.nextToolCall.tool, hint.nextToolCall.input, hint.nextToolCall.description); }
                  onThought?.({ type: 'thinking', label: `[Strategy switch] Synthesized: ${hint.nextAction.slice(0, 100)}`, timestamp: new Date() });
                }
              }
            }
          } else {
            stateManager.setRunPhase(execState, 'RECOVERY_REQUIRED');
            stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
            onText(`\n${recovMsgs.rebuildFailed ?? 'Recovery failed — execution state cannot be rebuilt.'}\n`);
            break;
          }
        }
      }

      // DD9: After N cached rereads, bypass LLM and force next write step.
      // Use computeDeterministicNextStep first (DD5), then fall back to stored nextToolCall.
      if ((execState.blockedReadCount ?? 0) >= 3) {
        const deterministicBypass = stateManager.computeDeterministicNextStep(execState, detectedWsType);
        const bypassNtc = deterministicBypass?.nextToolCall ?? execState.nextToolCall;
        if (bypassNtc && !VIRTUAL_TOOLS.has(bypassNtc.tool)) {
          contextCostTracker.recordSkippedLLMCall();
          onThought?.({ type: 'thinking', label: `[Blocked-read bypass] Dispatching: ${bypassNtc.tool}`, timestamp: new Date() });
          const bypassResult = await this.toolDispatcher.dispatch(
            { id: `bypass-${Date.now()}`, name: bypassNtc.tool, input: bypassNtc.input as Record<string, unknown> },
            agentId, onApproval, onDiff, onThought
          );
          stateManager.markToolExecuted(execState, bypassNtc.tool, (bypassNtc.input as Record<string, unknown>).path as string | undefined, bypassResult.text.slice(0, 150));
          stateManager.clearNextToolCall(execState);
          execState.blockedReadCount = 0;
          stateManager.resetToolLoop(execState);
          stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
          const truncBypass = bypassResult.text.length > 8000 ? bypassResult.text.slice(0, 8000) + '\n[truncated]' : bypassResult.text;
          const bypassMsg: ChatMessage = { role: 'tool_result', content: `<tool_result name="${bypassNtc.tool}">\n${truncBypass}\n</tool_result>` };
          messages.push(bypassMsg);
          currentStepToolResults.push(bypassMsg);
          calledATool = true;
          continueLoop = true;
          iterationCount++; // Prevent infinite loop — count bypass dispatches
          continue;
        } else {
          const bypassHint = deterministicBypass ?? stateManager.computeNextStep(execState, execState.lastExecutedTool ?? 'none', undefined, '', detectedWsType);
          if (bypassHint) {
            effectiveUserContent = bypassHint.nextAction;
            if (bypassHint.nextToolCall && !VIRTUAL_TOOLS.has(bypassHint.nextToolCall.tool)) {
              stateManager.setNextToolCall(execState, bypassHint.nextToolCall.tool, bypassHint.nextToolCall.input, bypassHint.nextToolCall.description);
            }
            execState.blockedReadCount = 0;
            onThought?.({ type: 'thinking', label: `[Blocked-read bypass] Synthesized: ${bypassHint.nextAction.slice(0, 100)}`, timestamp: new Date() });
          }
        }
      }

      // Task 9: Detect repetitive narration and force write
      if (this.isRepetitiveNarration(messages, writtenPaths)) {
        const narDeterministic = stateManager.computeDeterministicNextStep(execState, detectedWsType);
        const narNtc = narDeterministic?.nextToolCall ?? execState.nextToolCall;
        if (narNtc && !VIRTUAL_TOOLS.has(narNtc.tool)) {
          contextCostTracker.recordSkippedLLMCall();
          onThought?.({ type: 'thinking', label: `[Narration bypass] Dispatching: ${narNtc.tool}`, timestamp: new Date() });
          const narBypassResult = await this.toolDispatcher.dispatch(
            { id: `narbypass-${Date.now()}`, name: narNtc.tool, input: narNtc.input as Record<string, unknown> },
            agentId, onApproval, onDiff, onThought
          );
          stateManager.markToolExecuted(execState, narNtc.tool, (narNtc.input as Record<string, unknown>).path as string | undefined, narBypassResult.text.slice(0, 150));
          stateManager.clearNextToolCall(execState);
          stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
          const truncNar = narBypassResult.text.length > 8000 ? narBypassResult.text.slice(0, 8000) + '\n[truncated]' : narBypassResult.text;
          const narMsg: ChatMessage = { role: 'tool_result', content: `<tool_result name="${narNtc.tool}">\n${truncNar}\n</tool_result>` };
          messages.push(narMsg);
          currentStepToolResults.push(narMsg);
          calledATool = true;
          continueLoop = true;
          iterationCount++; // Prevent infinite loop — count narration bypass dispatches
          continue;
        } else {
          // Replace the user message with a forced write instruction
          effectiveUserContent = 'TOOL ONLY — do not narrate. Write the first implementation file now.';
          onThought?.({ type: 'thinking', label: '[Narration bypass] Forcing write instruction', timestamp: new Date() });
        }
      }

      // DD9: Controller-side direct dispatch for deterministic steps.
      // Before each provider call in code mode, check if a deterministic next step
      // can be dispatched directly — avoiding an expensive LLM turn for obvious moves.
      // IMPORTANT: Only MCP-routable tools can be directly dispatched. Virtual tools
      // (declare_file_batch, update_task_state) are handled inside the streaming event
      // handler and must NOT be dispatched here — they would fail with "Tool not found".
      if (mode === 'code' && iterationCount > 0) {
        const sameToolLoopCount = execState.sameToolLoop?.count ?? 0;
        const isGreenfieldBootstrap = detectedWsType === 'greenfield' && execState.artifactsCreated.length === 0;
        const hasPlanNoBatch = !!execState.approvedPlanPath && (execState.plannedFileBatch ?? []).length === 0;
        const shouldDirectDispatch = sameToolLoopCount >= 2 || isGreenfieldBootstrap || hasPlanNoBatch;

        if (shouldDirectDispatch) {
          const dd9Step = stateManager.computeDeterministicNextStep(execState, detectedWsType);
          // Only dispatch if the tool is a real MCP tool, not a virtual tool
          if (dd9Step?.nextToolCall && !VIRTUAL_TOOLS.has(dd9Step.nextToolCall.tool)) {
            contextCostTracker.recordSkippedLLMCall();
            const dd9Ntc = dd9Step.nextToolCall;
            onThought?.({ type: 'thinking', label: `[DD9 direct dispatch] ${dd9Ntc.tool}: ${dd9Ntc.description ?? ''}`, timestamp: new Date() });
            const dd9Result = await this.toolDispatcher.dispatch(
              { id: `dd9-${Date.now()}`, name: dd9Ntc.tool, input: dd9Ntc.input as Record<string, unknown> },
              agentId, onApproval, onDiff, onThought
            );
            stateManager.markToolExecuted(execState, dd9Ntc.tool, (dd9Ntc.input as Record<string, unknown>).path as string | undefined, dd9Result.text.slice(0, 150));
            stateManager.clearNextToolCall(execState);
            stateManager.resetToolLoop(execState);
            stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
            const truncDd9 = dd9Result.text.length > 8000 ? dd9Result.text.slice(0, 8000) + '\n[truncated]' : dd9Result.text;
            const dd9Msg: ChatMessage = { role: 'tool_result', content: `<tool_result name="${dd9Ntc.tool}">\n${truncDd9}\n</tool_result>` };
            messages.push(dd9Msg);
            currentStepToolResults.push(dd9Msg);
            if (dd9Ntc.tool === 'write_file' && dd9Result.status === 'success') {
              const dd9Path = (dd9Ntc.input as Record<string, unknown>).path as string | undefined;
              if (dd9Path) {
                writtenPaths.add(dd9Path);
                stateManager.markFileWritten(execState, this.normalizeWorkspacePath(dd9Path));
                stateManager.markProgress(execState);
                this.recordArtifact(agentId, dd9Path).catch(() => { /* non-fatal */ });
              }
            }
            calledATool = true;
            continueLoop = true;
            iterationCount++; // Prevent infinite loop — count DD9 dispatches
            continue;
          }
        }
      }

      // Phase 1: PromptAssembler — code mode uses compact, no-history messages per EQ-15.
      // All other modes use prepareMessagesForProvider.
      let messagesForProvider: ChatMessage[];
      if (mode === 'code') {
        // DD7: Build compact context packet from execution state for prompt assembly.
        const contextPacket = contextPacketBuilder.build(
          execState, detectedWsType, undefined, effectiveUserContent
        );
        const compactSummary = contextPacket.stateSummary;
        const compactWorkspace = contextPacket.workspaceSummary;

        messagesForProvider = promptAssembler.assembleMessages({
          systemPrompt: fullSystem,
          executionStateSummary: compactSummary,
          workspaceSummary: compactWorkspace,
          currentInstruction: effectiveUserContent,
          currentStepToolResults: [...currentStepToolResults],
          milestoneSummary: execState.lastExecutedTool
            ? `Last tool: ${execState.lastExecutedTool}`
            : undefined,
          // Phase 8.4 — inject template-specific skill fragments
          activeSkills: activeSkills.length > 0 ? activeSkills : undefined,
        });

        // DD12: Record per-turn context cost telemetry.
        const skillFragmentText = activeSkills.length > 0 ? activeSkills.join('\n') : '';
        const toolResultText = currentStepToolResults.map(m => m.content).join('\n');
        const costEntry = contextCostTracker.record(
          iterationCount,
          fullSystem,
          compactSummary,
          compactWorkspace,
          skillFragmentText,
          effectiveUserContent,
          toolResultText,
        );
        // DD7: Track summary reuse — check if any resolved input summaries were reused
        for (const ris of contextPacket.resolvedInputSummaries) {
          const cached = fileSummaryStore.getByPath(ris.path);
          if (cached) {
            contextCostTracker.recordSummaryReuse();
          }
        }
        onThought?.({
          type: 'thinking',
          label: `[ContextCost] turn=${costEntry.turn} tokens=${costEntry.totalTokens} summariesReused=${costEntry.resolvedSummariesReused} rawFiles=${costEntry.rawFileContentsInjected}`,
          timestamp: new Date(),
        });

        // Reset after use — tool results from THIS iteration will repopulate it below
        currentStepToolResults.length = 0;
      } else {
        // Non-code modes: sanitise tool_result roles
        messagesForProvider = this.prepareMessagesForProvider(messages);
      }
      for await (const event of provider.stream(messagesForProvider, this.filterToolsByMode(tools, mode), actualMaxOutputTokens)) {
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

          // Phase 5.1 — Silent execution: suppress pre-tool narration from visible stream
          // When silentExecution is active, do NOT pass text to onText().
          // Still accumulate for protocol-leak detection and degenerate-response guard.
          if (silentExecution) {
            fullResponse += cleanDelta; // internal accumulation only, no onText()
          } else {
            onText(cleanDelta);
            fullResponse += cleanDelta;
          }

          // Phase 1.3: speculative text filter — if the delta looks like a tool-syntax
          // label (model narrating its own tool calls as text), accumulate it for display
          // but flag it so it is not included in state-mutation paths.
          const looksLikeToolSyntax = (s: string) =>
            /\[(write_file|edit_file|read_file|list_files|run_command):/i.test(s) ||
            /^TOOL:/m.test(s) ||
            /<tool_result/i.test(s);
          if (looksLikeToolSyntax(cleanDelta)) {
            onThought?.({
              type: 'thinking',
              label: 'Speculative tool text detected in assistant stream — not persisting as state',
              detail: cleanDelta.slice(0, 120),
              timestamp: new Date(),
            });
            // Do not add to turnAssistantText so it won't be pushed to messages history
          } else {
            turnAssistantText += cleanDelta;
          }
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
            // Use a format that does NOT match the sanitiser's [write_file: ...] pattern,
            // which would trigger false-positive PROTOCOL_TEXT_IN_TRANSCRIPT recovery.
            const verb = event.name === 'write_file' ? 'Wrote' : 'Edited';
            const sizeNote = toolCallContent ? ` (${toolCallContent.length} chars)` : '';
            assistantTurnLabel = `${verb} ${toolCallPath}${sizeNote}`;
          } else {
            // Encode as a null-byte-delimited marker so GeminiProvider can convert
            // this into a native functionCall part.  The model never emits null bytes
            // so it cannot reproduce this format as plain text output.
            const argsJson = JSON.stringify(event.input ?? {});
            assistantTurnLabel = `\x00TOOL:${event.name}:${argsJson}\x00`;
          }
          messages.push({ role: 'assistant', content: turnAssistantText || assistantTurnLabel });
          turnAssistantText = '';

          // Phase 1.2 — ExecutionSubPhase transitions (in-memory observability)
          if (event.name === 'declare_file_batch') {
            stateManager.setExecutionPhase(execState, 'PLANNING_BATCH');
          } else if (MUTATION_TOOLS.has(event.name)) {
            stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
          } else if (DISCOVERY_TOOLS.has(event.name)) {
            stateManager.setExecutionPhase(execState, 'DISCOVERING');
          }

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
            toolResultContent = `<tool_result name="${event.name}" status="error">\n${rejection}\n</tool_result>`;
            onThought({ type: 'error', label: `Rewrite blocked: ${toolCallPath}`, detail: rejection, timestamp: new Date() });
          } else if (isFileWrite && toolCallPath && (() => {
            // ─── Batch enforcement (Phase 4) ─────────────────────────────────
            // Greenfield/scaffolded: must declare a batch before first write_file.
            // Exempt plan mode document writes — plans are single-file documentation,
            // not code artifacts that need batch coordination.
            const docExt = toolCallPath.split('.').pop()?.toLowerCase() ?? '';
            if (mode === 'plan' && ['md', 'txt', 'rst'].includes(docExt)) {
              return null; // skip batch enforcement for plan documents
            }
            const normalizedBatchPath = this.normalizeWorkspacePath(toolCallPath);
            const batchMsg = getAppData().executionMessages.toolBlocked.offBatch;
            return batchEnforcer.checkWritePermission(
              normalizedBatchPath, execState, batchMsg, detectedWorkspaceType
            );
          })()) {
            const normalizedBatchPath = this.normalizeWorkspacePath(toolCallPath);
            const batchMsg = getAppData().executionMessages.toolBlocked.offBatch;
            const batchRejection = batchEnforcer.checkWritePermission(
              normalizedBatchPath, execState, batchMsg, detectedWorkspaceType
            ) ?? batchMsg;
            agentLog.logToolResult(event.name, batchRejection);
            toolResultContent = `<tool_result name="${event.name}" status="error">\n${batchRejection}\n</tool_result>`;
            onThought({ type: 'error', label: `Batch violation: ${toolCallPath}`, detail: batchRejection, timestamp: new Date() });
          } else if (isFileWrite && toolCallPath && registeredArtifactPaths.has(this.normalizeWorkspacePath(toolCallPath))) {
            // ─── Cross-session artifact guard ────────────────────────────────
            // File was created in a PREVIOUS session. Prevent silent re-creation
            // that discards prior work. Force the model to use edit_file instead.
            const normalizedGuard = this.normalizeWorkspacePath(toolCallPath);
            const rejection = `[SYSTEM ERROR] write_file REJECTED: "${normalizedGuard}" already exists from a previous session (artifact registry). The file has NOT been changed. Use edit_file to modify it, or read it first to see what was already written.`;
            agentLog.logToolResult(event.name, rejection);
            turnMemory.addToolResult(event.name, rejection);
            toolResultContent = `<tool_result name="${event.name}" status="error">\n${rejection}\n</tool_result>`;
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
              // Phase 4: terminal/wait state fields
              session_phase?: string;
              wait_state_reason?: string;
              // Phase 2: structured next tool call for direct dispatch on resume
              next_tool_call?: { tool: string; input: Record<string, unknown>; description?: string };
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
            // Phase 4: terminal/wait state
            if (updates.session_phase) {
              stateManager.setRunPhase(execState, updates.session_phase as SessionPhase, updates.wait_state_reason);
            }
            // Phase 2: structured next tool call for direct dispatch
            if (updates.next_tool_call) {
              const ntc = updates.next_tool_call;
              stateManager.setNextToolCall(execState, ntc.tool, ntc.input, ntc.description);
            }
            // Save immediately so the state is durable even if max-iterations hit
            stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
            const summary = [
              updates.completed_step ? `completed_step recorded` : '',
              updates.next_actions !== undefined ? `next_actions: ${execState.nextActions.length}` : '',
              updates.tech_stack ? `tech_stack: ${JSON.stringify(execState.techStack)}` : '',
              updates.session_phase ? `session_phase: ${updates.session_phase}` : '',
              updates.next_tool_call ? `next_tool_call: ${updates.next_tool_call.tool}` : '',
            ].filter(Boolean).join(', ');
            agentLog.logToolResult(event.name, summary);
            toolResultContent = `[Task state updated — ${summary}]`;
            // Phase 1 fix: virtual tools must also increment iterationsUsed
            stateManager.markToolExecuted(execState, event.name, undefined, toolResultContent.slice(0, 150));
          } else if (event.name === 'declare_file_batch') {
            // ─── In-process write-batch declaration (#7) ──────────────────────
            const inp = event.input as { files: string[]; rationale?: string };
            const newFiles = (inp.files ?? []).map(f => this.normalizeWorkspacePath(f));

            // Idempotency: reject empty batch declarations and duplicate batch declarations
            if (newFiles.length === 0) {
              toolResultContent = `[BATCH REJECTED] declare_file_batch requires a non-empty "files" array. Provide the list of files you plan to write.`;
              agentLog.logToolResult(event.name, 'rejected: empty files array');
            } else if (execState.plannedFileBatch.length > 0) {
              // A batch is already active — reject the duplicate
              toolResultContent = `[BATCH_ALREADY_ACTIVE] A batch of ${execState.plannedFileBatch.length} file(s) is already declared. Write the remaining batch files instead of re-declaring. Remaining: ${
                execState.plannedFileBatch.filter(f => !(execState.completedBatchFiles ?? []).includes(f)).slice(0, 5).join(', ')
              }`;
              agentLog.logToolResult(event.name, 'rejected: batch already active');
            } else {
              execState.plannedFileBatch = newFiles;
              stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
              agentLog.logToolResult(event.name, `batch declared: ${newFiles.length} files`);
              toolResultContent = `[Batch declared: ${newFiles.length} file(s) — ` +
                `${inp.rationale ?? 'no rationale'}. Write all of them before this session ends.]`;
            }
            // Phase 1 fix: virtual tools must also increment iterationsUsed
            stateManager.markToolExecuted(execState, event.name, undefined, (toolResultContent ?? '').slice(0, 150));
          } else {
            // Task 10: Same-tool same-path loop breaker
            const toolPathKey = `${event.name}:${toolCallPath ?? ''}`;
            const toolPathCount = (toolPathCounts.get(toolPathKey) ?? 0) + 1;
            toolPathCounts.set(toolPathKey, toolPathCount);

            let toolResult: DispatchResult;
            if (toolPathCount >= 3 && ['read_file', 'list_files', 'search_files'].includes(event.name)) {
              // Same read-only tool+path 3+ times — force a write
              toolResult = {
                text: `[LOOP DETECTED] "${event.name}" on "${toolCallPath}" has been called ${toolPathCount} times with no writes. Stop reading and write a file now.`,
                status: 'blocked',
                reasonCode: 'LOOP_DETECTED',
                toolName: event.name,
                path: toolCallPath,
              };
              onThought?.({ type: 'error', label: `Loop detected: ${event.name}:${toolCallPath} x${toolPathCount}`, timestamp: new Date() });
            } else {
              toolResult = await this.toolDispatcher.dispatch(
                event, agentId, onApproval, onDiff, onThought
              );
            }
            agentLog.logToolResult(event.name, toolResult.text);
            turnMemory.addToolResult(event.name, toolResult.text);

            // ── DD4: Structured dispatch result handling ──
            // Use structured status instead of parsing text prefixes.
            {
              const isBlockedResult = toolResult.status === 'blocked' || toolResult.status === 'cached' || toolResult.status === 'budget_exhausted';
              if (isBlockedResult) {
                // DD4: Track blocked/cached reads via structured reasonCode.
                if (toolResult.reasonCode === 'ALREADY_READ_UNCHANGED' || toolResult.reasonCode === 'LOOP_DETECTED') {
                  const normBlockedPath = toolCallPath ? this.normalizeWorkspacePath(toolCallPath) : '';
                  if (normBlockedPath && !blockedReadPaths.has(normBlockedPath)) {
                    blockedReadPaths.add(normBlockedPath);
                    stateManager.incrementBlockedRead(execState, normBlockedPath);
                  }
                  // DD4: Record tool loop for same-tool detection
                  stateManager.recordToolLoop(execState, event.name, toolCallPath);
                }
              }
              if (toolResult.status === 'success') {
                // Only record successful executions as ground-truth state.
                stateManager.markToolExecuted(execState, event.name, toolCallPath, toolResult.text.slice(0, 150));
                // DD4: Reset tool loop on success
                stateManager.resetToolLoop(execState);
                if (event.name === 'read_file' && toolCallPath) {
                  stateManager.markFileRead(execState, this.normalizeWorkspacePath(toolCallPath));
                  // Cache the full content so reread attempts return the content
                  // instead of a useless BLOCKED message.
                  this.toolDispatcher.cacheReadResult(toolCallPath, toolResult.text);
                  // DD7: Store file summary for hash-based reuse on subsequent turns.
                  const readSummary = fileSummaryStore.put(
                    this.normalizeWorkspacePath(toolCallPath),
                    toolResult.text,
                    toolResult.text.slice(0, 500),
                  );
                  stateManager.upsertResolvedInputSummary(execState, readSummary);
                  contextCostTracker.recordRawFileInjection();
                }

                // DD5: Compute deterministic next step first, fall back to advisory
                let nextStep = stateManager.computeDeterministicNextStep(execState, detectedWsType)
                  ?? stateManager.computeNextStep(execState, event.name, toolCallPath, toolResult.text, detectedWsType);
                // Auto-repair — if no step computed after read_file, force a write
                if (!nextStep && event.name === 'read_file') {
                  nextStep = {
                    nextAction: 'Write the next implementation file now — do not read more files',
                  };
                }
                if (nextStep) {
                  stateManager.setNextAction(execState, nextStep.nextAction);
                  if (nextStep.nextToolCall) {
                    stateManager.setNextToolCall(execState, nextStep.nextToolCall.tool, nextStep.nextToolCall.input, nextStep.nextToolCall.description);
                  }
                }
              }
            }

            // Truncate very large tool results so they don't dominate the context
            // window on subsequent iterations and cause the model to output tiny
            // narrations instead of the next tool call.
            const resultStr = toolResult.text;
            const MAX_TOOL_RESULT_CHARS = 8000;
            const truncatedResult = resultStr.length > MAX_TOOL_RESULT_CHARS
              ? resultStr.slice(0, MAX_TOOL_RESULT_CHARS) +
                `\n\n[... result truncated: ${resultStr.length - MAX_TOOL_RESULT_CHARS} more chars omitted from history ...]`
              : resultStr;
            toolResultContent = `<tool_result name="${event.name}">\n${truncatedResult}\n</tool_result>`;

            // ─── #6 Discovery budget enforcement ─────────────────────────────
            // Count consecutive reads with no writes. After the threshold,
            // replace the tool result with a hard directive and set the
            // execution phase to EXECUTING_STEP to force a write.
            const isReadOnlyTool = ['read_file', 'list_files', 'search_files', 'glob_files', 'grep_content'].includes(event.name);
            const isWriteOrActionTool = ['write_file', 'edit_file', 'run_command', 'replace_range', 'multi_edit'].includes(event.name);
            if (isReadOnlyTool) {
              consecutiveReadCount++;
            } else if (isWriteOrActionTool) {
              consecutiveReadCount = 0;
            }
            if (consecutiveReadCount >= 3 && writtenPaths.size === 0) {
              // Hard override at 3 reads: replace the tool result content, activate
              // discovery lock in ToolDispatcher, and force execution phase.
              // This prevents the advisory-only behaviour that allowed 6+ reads.
              toolResultContent = `[DISCOVERY BUDGET EXCEEDED] ${consecutiveReadCount} consecutive reads with no writes. Further discovery calls will be BLOCKED. You MUST call write_file or edit_file now. Do not read, list, or search any more files.`;
              stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
              // Activate hard lockout in ToolDispatcher so subsequent reads are rejected
              this.toolDispatcher.lockDiscovery();
              // Activate silent execution to suppress narration and force tool calls
              silentExecution = true;
            }

            if (isFileWrite && toolCallPath && toolResult.status === 'success' && toolResult.text.startsWith('File written')) {
              writtenPaths.add(toolCallPath);
              // Task 10: Reset tool+path loop counter on successful write
              toolPathCounts.clear();
              const pathList = Array.from(writtenPaths).map(p => `"${p}"`).join(', ');
              toolResultContent += `\n\nFiles written this task: ${pathList}. Use edit_file for any corrections to these paths.`;
              // Record in cross-session artifact registry so future sessions know what files exist.
              this.recordArtifact(agentId, toolCallPath).catch(() => { /* non-fatal */ });

              // Single authoritative mutation method handles artifactsCreated + completedBatchFiles
              stateManager.markFileWritten(execState, this.normalizeWorkspacePath(toolCallPath));
              // DD1: Record meaningful progress
              stateManager.markProgress(execState);

              // Verify all written files are still on disk every 5 writes
              if (writtenPaths.size % 5 === 0) {
                const missingFiles = await this.verifyWrittenFiles(Array.from(writtenPaths));
                if (missingFiles.length > 0) {
                  toolResultContent += `\n\n[Verification] Warning: ${missingFiles.length} file(s) appear missing from disk: ${missingFiles.join(', ')}. Investigate before continuing.`;
                }
              }
              // ─── #7 Batch progress ───────────────────────────────────────────
              const plannedBatch = execState.plannedFileBatch ?? [];
              if (plannedBatch.length > 0) {
                const completedBatch = execState.completedBatchFiles ?? execState.artifactsCreated;
                const remaining = plannedBatch.filter(p => !completedBatch.includes(p));
                const batchNote = remaining.length === 0
                  ? `[Batch complete: all ${plannedBatch.length} planned files written.]`
                  : `[Batch: ${completedBatch.length}/${plannedBatch.length} done. Remaining: ${remaining.slice(0, 4).join(', ')}${remaining.length > 4 ? ` +${remaining.length - 4} more` : ''}]`;
                toolResultContent += `\n${batchNote}`;
              }
            }

            // Save state after each tool dispatch to ensure durability
            stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });

            // Phase 4 — MilestoneFinalizer: check if we should stop/wait after this write
            if (event.name === 'write_file' || event.name === 'edit_file') {
              const milestoneContract = inferStepContract([], '', execState.runPhase ?? 'RUNNING');
              const milestoneDecision = milestoneFinalizer.decide(execState, milestoneContract, event.name, toolCallPath);
              if (milestoneDecision.action === 'WAIT') {
                stateManager.setRunPhase(execState, 'WAITING_FOR_USER_INPUT', milestoneDecision.message);
                stateManager.setExecutionPhase(execState, 'INITIALISING');
                stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
                const tsMsgs = getAppData().executionMessages.terminalStates ?? {} as Record<string, string>;
                onText(`\n${(tsMsgs.waitingForUserInput ?? 'Paused — waiting for your input. {reason}').replace('{reason}', milestoneDecision.message)}`);
                continueLoop = false;
              } else if (milestoneDecision.action === 'COMPLETE') {
                stateManager.setRunPhase(execState, 'COMPLETED');
                stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
                continueLoop = false;
              } else if (milestoneDecision.action === 'VALIDATE') {
                stateManager.setExecutionPhase(execState, 'VALIDATING_STEP');
                onThought?.({ type: 'thinking', label: `[Milestone] ${milestoneDecision.reason}`, timestamp: new Date() });
              }

              // Phase 7.1 — ConsistencyValidator in hot path (validatorEnforcement)
              // Run after each write to catch critical issues immediately.
              if (vsConfig.get<boolean>('validatorEnforcement', false) && MUTATION_TOOLS.has(event.name)) {
                stateManager.setExecutionPhase(execState, 'VALIDATING_STEP');
                const hotValidator = new ConsistencyValidator(this.workspaceRoot);
                const detectedLockHot = await archLock.detect();
                const hotIssues = await hotValidator.validate(
                  Array.from(writtenPaths),
                  execState,
                  detectedLockHot ?? undefined
                );
                const criticals = hotIssues.filter(i => i.severity === 'critical');
                const warnings = hotIssues.filter(i => i.severity !== 'critical' && i.severity !== undefined);
                if (warnings.length > 0) {
                  onThought?.({
                    type: 'thinking',
                    label: `[Validator] ${warnings.length} warning(s)`,
                    detail: warnings.map(w => `${w.path}: ${w.issue}`).join('\n'),
                    timestamp: new Date(),
                  });
                }
                if (criticals.length > 0) {
                  const tsMsgs = getAppData().executionMessages.terminalStates ?? {} as Record<string, string>;
                  stateManager.setRunPhase(execState, 'BLOCKED_BY_VALIDATION');
                  stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
                  onText(`\n${tsMsgs.blockedByValidation ?? 'Blocked — validation issues must be resolved before continuing.'}`);
                  onThought?.({
                    type: 'error',
                    label: `[Validator] ${criticals.length} critical issue(s) — blocking run`,
                    detail: criticals.map(c => `${c.path}: ${c.issue}`).join('\n'),
                    timestamp: new Date(),
                  });
                  continueLoop = false;
                } else {
                  stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
                }
              }
            }
          }
          // Push as 'tool_result' role so it is distinguishable from genuine user
          // messages.  prepareMessagesForProvider() converts it back to 'user' (stripping
          // the XML wrapper) just before the next provider.stream() call.
          // Also accumulate in currentStepToolResults for PromptAssembler (Phase 1).
          {
            const toolResultMsg: ChatMessage = { role: 'tool_result', content: toolResultContent, toolCallId: event.id };
            messages.push(toolResultMsg);
            currentStepToolResults.push(toolResultMsg);
          }
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

      // DD8: Cap audit transcript in code mode to prevent unbounded growth.
      // Provider calls are built fresh by PromptAssembler, so messages only serves
      // recovery/narration detection. Keep system prompt + last N entries.
      if (mode === 'code' && messages.length > AUDIT_TRANSCRIPT_MAX + 1) {
        const systemMsg = messages[0]; // preserve system prompt
        const recentEntries = messages.slice(-(AUDIT_TRANSCRIPT_MAX));
        messages.splice(0, messages.length, systemMsg, ...recentEntries);
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

          // Detect when silent execution should be activated
          if (isNarratingNextCall && !silentExecution) {
            silentExecution = true;
          }

          if (isNarratingNextCall && nudgeRetryCount < MAX_NUDGE_RETRIES) {
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
            // Use system message for harder constraint
            messages.push({ role: 'system', content: 'Call the next tool now. Do not narrate — execute immediately.' });
            nudgeRetryCount++;
            continueLoop = true;
          } else if (isNarratingNextCall && nudgeRetryCount >= MAX_NUDGE_RETRIES) {
            // V2: nudge cap reached — force loop exit to prevent infinite nudge cycle
            onThought({
              type: 'error',
              label: 'Nudge retry cap reached — forcing loop exit',
              detail: `Model failed to call a tool after ${MAX_NUDGE_RETRIES} nudges`,
              timestamp: new Date(),
            });
            continueLoop = false;
          }
        }
        if (!continueLoop) {
          continueLoop = false;
        }
      }

      // Discard pure narration turns when silent execution is active
      if (silentExecution && !calledATool && turnAssistantText) {
        const isPureNarration = turnAssistantText.trim().length < 500 &&
          !turnAssistantText.includes('```') &&
          !turnAssistantText.includes('{') &&
          !turnAssistantText.includes('error') &&
          !toolsUsed.length;
        if (isPureNarration) {
          onThought({
            type: 'thinking',
            label: 'Silent execution: discarding pure narration turn',
            detail: turnAssistantText.slice(0, 120),
            timestamp: new Date(),
          });
          turnAssistantText = '';
        }
      }

      // Bug-fix004 item 15 — ProgressGuard: evaluate whether this turn made progress.
      // After MAX_NON_PROGRESS consecutive non-productive turns, force recovery.
      {
        const lastToolUsed = toolsUsed.length > 0 ? toolsUsed[toolsUsed.length - 1] : undefined;
        const lastToolStatus = calledATool ? 'success' : undefined; // simplified — blocked tools don't set calledATool
        const hadTextOnly = !calledATool && !!(turnAssistantText || lastAssistantText);
        const progressVerdict = progressGuard.evaluate(calledATool, lastToolUsed, lastToolStatus, hadTextOnly);
        if (progressVerdict === 'RECOVERY_REQUIRED') {
          onThought?.({
            type: 'thinking',
            label: `[ProgressGuard] ${progressGuard.getState().nonProgressCount} non-progress turns — forcing recovery`,
            timestamp: new Date(),
          });
          // Trigger recovery by setting state and letting the next iteration handle it
          execState.blockedReadCount = Math.max(execState.blockedReadCount ?? 0, 3);
          progressGuard.reset();
        }
      }

      // Phase 2.2 — StepContract inference
      // Classify the iteration outcome and drive loop continuation.
      {
        const contract = inferStepContract(toolsUsed, turnAssistantText || lastAssistantText, execState.runPhase ?? 'RUNNING');
        onThought?.({
          type: 'thinking',
          label: `[StepContract] kind=${contract.kind}${contract.toolName ? ` tool=${contract.toolName}` : ''}`,
          timestamp: new Date(),
        });

        // Phase 5.2 — Silent reprompt: if silent mode and no tool call, send one terse reprompt
        if (silentExecution && !calledATool && contract.kind === 'pause') {
          if (silentRepromptCount < MAX_SILENT_REPROMPTS) {
            silentRepromptCount++;
            onThought?.({ type: 'thinking', label: `Silent reprompt #${silentRepromptCount}`, timestamp: new Date() });
            messages.push({ role: 'system', content: 'TOOL ONLY — call the next tool immediately, no text.' });
            continueLoop = true;
          } else {
            // Max reprompts exceeded — treat as blocked
            onThought?.({ type: 'error', label: 'Silent reprompt cap reached — treating as blocked', timestamp: new Date() });
            stateManager.setRunPhase(execState, 'BLOCKED_BY_VALIDATION');
            continueLoop = false;
          }
        } else {
          // Normal (non-silent) terminal contracts should stop the loop
          if (contract.kind !== 'tool' && !calledATool) {
            if (contract.kind === 'complete') {
              stateManager.setRunPhase(execState, 'COMPLETED');
              continueLoop = false;
            } else if (contract.kind === 'blocked') {
              stateManager.setRunPhase(execState, contract.recoverable ? 'BLOCKED_BY_VALIDATION' : 'RECOVERY_REQUIRED');
              continueLoop = false;
            } else if (contract.kind === 'pause') {
              continueLoop = false;
            }
          }
        }
      }

      // ─── BATCH CONTINUATION ENFORCEMENT ────────────────────────────────────
      // If a batch is active with remaining files and the loop would stop,
      // override the stop decision. This is the primary fix for the bug where
      // the agent stops after writing one file when there are 17 remaining.
      // The framework MUST force continuation — the LLM's narration/pause
      // should not end a session with an active batch.
      if (!continueLoop && iterationCount < maxToolIterations) {
        const batchPlanned = execState.plannedFileBatch ?? [];
        const batchCompleted = execState.completedBatchFiles ?? [];
        const batchRemaining = batchPlanned.filter(f => !batchCompleted.includes(f));
        const isTerminalPhase = execState.runPhase !== undefined && execState.runPhase !== 'RUNNING';

        if (batchRemaining.length > 0 && !isTerminalPhase) {
          const nextBatchFile = batchRemaining[0];
          onThought?.({
            type: 'thinking',
            label: `[Batch continuation] Active batch has ${batchRemaining.length} remaining file(s) — forcing continuation to: ${nextBatchFile}`,
            timestamp: new Date(),
          });
          // Replace the effective user content with a direct write instruction
          effectiveUserContent = `Write the next batch file now: ${nextBatchFile}. Generate the full file content. Do not re-read any files — you have all the information you need from the plan and prior context.`;
          // Clear current-step tool results so the prompt is compact
          currentStepToolResults.splice(0, currentStepToolResults.length);
          // Activate silent execution mode to suppress narration
          silentExecution = true;
          continueLoop = true;
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
      // Sanitise the user message too before persisting (defence-in-depth).
      const userMsgToStore = { ...userMsg, content: sanitiseContent(userMsg.content) };
      this.memoryManager.addMessage(agentId, userMsgToStore);
      // Store only the final text segment (not the full concatenation of all
      // iterations) so history does not contain duplicate summaries.
      // Sanitise before persisting to strip any tool-protocol noise that leaked
      // into assistant text (e.g. [write_file: ...], TOOL:... sentinels).
      const rawAssistantContent = lastAssistantText || fullResponse;
      // DD11: Apply code-mode narration sanitiser on top of protocol sanitiser
      const sanitised = this.sanitiseAssistantText(rawAssistantContent);
      const assistantContent = mode === 'code'
        ? sanitiseCodeModeNarration(this.filterNarrationBeforePersist(sanitised))
        : this.filterNarrationBeforePersist(sanitised);
      const assistantMsg: ChatMessage = { role: 'assistant', content: assistantContent };
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

    // ─── #8 Consistency validator ─────────────────────────────────────────────
    if (writtenPaths.size > 0) {
      const validator = new ConsistencyValidator(this.workspaceRoot);
      const detectedLock = await archLock.detect();
      const issues = await validator.validate(
        Array.from(writtenPaths),
        execState,
        detectedLock ?? undefined
      );
      if (issues.length > 0) {
        // Auto-fix safe issues when validatorEnforcement flag is on
        if (vsConfig.get<boolean>('validatorEnforcement', false)) {
          const fixed = await validator.autoFix(issues);
          if (fixed.length > 0) {
            onThought({
              type: 'thinking',
              label: `Validator auto-fixed ${fixed.length} issue(s)`,
              detail: fixed.join('\n'),
              timestamp: new Date(),
            });
          }
        }
        const critical = issues.filter(i => i.severity === 'critical');
        const warnings = issues.filter(i => !i.severity || i.severity !== 'critical');
        const issueText = issues.map(i => `- [${i.severity ?? 'warning'}] ${i.path}: ${i.issue}`).join('\n');
        onThought({
          type: critical.length > 0 ? 'error' : 'thinking',
          label: `Consistency check: ${issues.length} issue(s) found (${critical.length} critical)`,
          detail: issueText,
          timestamp: new Date(),
        });
        if (critical.length > 0 || warnings.length > 0) {
          onText(`\n\n[Consistency Check]\n${issueText}`);
        }
      }
    }

    // ─── #18 Post-run health score ────────────────────────────────────────────
    {
      const totalCalls = toolsUsed.length;
      const readCalls  = toolsUsed.filter(t => ['read_file', 'list_files', 'search_files'].includes(t)).length;
      const writeCalls = toolsUsed.filter(t => ['write_file', 'edit_file'].includes(t)).length;
      // DD12: Include context cost summary in health telemetry.
      const costSummary = contextCostTracker.getSummary();
      const health = {
        iterationLoad: Math.round((iterationCount / maxToolIterations) * 100),
        readRatio:     totalCalls > 0 ? Math.round((readCalls / totalCalls) * 100) : 0,
        writeCount:    writeCalls,
        discoveryBudgetTriggered: consecutiveReadCount >= 3,
        verificationPerformed: writtenPaths.size >= 5,
        contextCost: {
          totalTurns: costSummary.totalTurns,
          totalTokens: costSummary.totalTokens,
          avgTokensPerTurn: costSummary.avgTokensPerTurn,
          llmCallsSkipped: costSummary.llmCallsSkipped,
        },
      };
      const overall = Math.max(0, 100
        - (health.iterationLoad > 80 ? 30 : health.iterationLoad > 60 ? 15 : 0)
        - (health.readRatio > 70 ? 20 : health.readRatio > 50 ? 10 : 0)
        - (health.discoveryBudgetTriggered ? 10 : 0));
      onThought({
        type: 'thinking',
        label: `Session health: ${overall}/100`,
        detail: JSON.stringify(health, null, 2),
        timestamp: new Date(),
      });
    }

    // Always save execution state — even for incomplete sessions — so the
    // continue contract can resume from the last known position next invocation.
    // iterationsUsed is already incremented by markToolExecuted() for each
    // individual tool call; do NOT add iterationCount (LLM request count) again.
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
      // Task 9: Filter out .bormagi/ internal paths so the model does not see
      // framework state files (e.g. .bormagi/plans/...) as continuation targets.
      const visibleEntries = entries.filter(e => !e.path.replace(/\\/g, '/').startsWith('.bormagi/'));
      if (visibleEntries.length === 0) { return ''; }
      const lines = visibleEntries.map(e => `- ${e.path} (created by ${e.agentId})`).join('\n');
      return `[Artifact Registry — files created in previous sessions]\n${lines}\n\nBefore writing any file, check if it already exists at one of these paths.`;
    } catch {
      return '';
    }
  }

  // ─── DD10: Plan approval resolution ──────────────────────────────────────

  /**
   * Resolve the approved plan path from the artifact registry.
   * Looks for plan files (.md) under .bormagi/plans/ or in the artifact registry.
   * Returns the path if found, null otherwise.
   */
  private resolveApprovedPlanPath(
    execState: ExecutionStateData,
    registeredArtifactPaths: Set<string>,
    userMessage: string,
  ): string | null {
    // Check if user explicitly references a plan path
    const planPathMatch = userMessage.match(/(?:plan|spec)\s+(?:at\s+)?["']?([^\s"']+\.md)["']?/i);
    if (planPathMatch) {
      return this.normalizeWorkspacePath(planPathMatch[1]);
    }

    // Look for plan files in the artifact registry
    for (const artifactPath of registeredArtifactPaths) {
      const norm = artifactPath.replace(/\\/g, '/');
      if (norm.includes('plan') && norm.endsWith('.md')) {
        return norm;
      }
    }

    // Look for plan files in resolvedInputs
    for (const inputPath of execState.resolvedInputs) {
      const norm = inputPath.replace(/\\/g, '/').toLowerCase();
      if ((norm.includes('plan') || norm.includes('.bormagi/plans/')) && norm.endsWith('.md')) {
        return inputPath;
      }
    }

    return null;
  }

  // ─── Task 9: Repetitive narration detection ─────────────────────────────

  /**
   * Detect if the last 2-3 assistant messages are repetitive narration with no writes.
   * Used to bypass the LLM call and force a write step instead.
   */
  private isRepetitiveNarration(messages: ChatMessage[], writtenPaths: Set<string>): boolean {
    if (writtenPaths.size > 0) return false;
    const recentAssistant = messages
      .filter(m => m.role === 'assistant')
      .slice(-3)
      .map(m => m.content.toLowerCase());
    if (recentAssistant.length < 2) return false;
    const NARRATION_PATTERNS = [
      /i'll start by reading/,
      /let me (first )?read/,
      /let me check/,
      /i need to (first )?read/,
      /i can see from the log/,
      /i'll read the/,
      /let me start by/,
    ];
    return recentAssistant.every(text =>
      NARRATION_PATTERNS.some(p => p.test(text))
    );
  }

  // ─── Task 2: Filter narration before persisting assistant text ─────────

  /**
   * Filter out speculative narration patterns from assistant text before
   * persisting to session history. Only persist final summary, milestone,
   * or completion/blocker text.
   */
  private filterNarrationBeforePersist(text: string): string {
    const NARRATION_LINE_PATTERNS = [
      /^I'll start by\b/i,
      /^Let me read\b/i,
      /^Let me first\b/i,
      /^I can see from the log\b/i,
      /^I need to first\b/i,
    ];
    const lines = text.split('\n');
    const filtered = lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true; // keep blank lines
      return !NARRATION_LINE_PATTERNS.some(p => p.test(trimmed));
    });
    const result = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // If filtering removed everything, return original to avoid empty persist
    return result || text;
  }

  // ─── #13 Mode-based tool filtering ───────────────────────────────────────

  /**
   * Return only the tools that are appropriate for the current assistant mode.
   * This prevents write/execute tools from being offered in review/chat modes
   * and reduces the surface area for accidental destructive actions.
   */
  private filterToolsByMode(tools: MCPToolDefinition[], mode: AssistantMode): MCPToolDefinition[] {
    if (mode === 'ask') {
      // Ask / Q&A mode: read-only tools only — no writes, no command execution.
      // Includes all Tier 1 code-nav tools (search/read only, no edits).
      const READ_ONLY = new Set([
        'read_file', 'list_files', 'search_files',
        'glob_files', 'grep_content',
        'read_file_range', 'read_head', 'read_tail', 'read_match_context',
        'git_status', 'git_diff', 'git_log',
        'get_diagnostics', 'update_task_state',
      ]);
      return tools.filter(t => READ_ONLY.has(t.name));
    }
    if (mode === 'plan') {
      // Plan mode: allow reads + document creation; block destructive execution.
      // Edit tools (replace_range, multi_edit, symbol edits) are also blocked.
      const BLOCKED = new Set([
        'run_command', 'git_commit', 'git_push', 'git_create_pr', 'gcp_deploy',
        'replace_range', 'multi_edit',
        'replace_symbol_block', 'insert_before_symbol', 'insert_after_symbol',
      ]);
      return tools.filter(t => !BLOCKED.has(t.name));
    }
    // code (default): all tools available
    return tools;
  }

  /** Return a short system note describing workspace maturity to the model. */
  private buildWorkspaceTypeNote(wsType: 'greenfield' | 'docs_only' | 'scaffolded' | 'mature'): string {
    switch (wsType) {
      case 'greenfield':
        return '[Workspace: empty] No project files or documentation present.';
      case 'docs_only':
        return '[Workspace: docs_only] Documentation and plan files present. No project manifest or source code yet.';
      case 'scaffolded':
        return '[Workspace: scaffolded] Early-stage project with fewer than 5 source files.';
      case 'mature':
        return '[Workspace: mature] Established codebase.';
    }
  }

  // ─── V2 execution engine helpers ─────────────────────────────────────────

  /**
   * Strip tool-protocol noise from assistant text before it is persisted to
   * session history. This prevents speculative text such as "[write_file: ...]"
   * or "\x00TOOL:...\x00" from being replayed as real state on resume.
   *
   * Only strips known control-plane markers — legitimate response text is kept.
   */
  /**
   * Convert internal 'tool_result' role messages to provider-compatible 'user' messages,
   * and strip any residual control-plane patterns from all messages.
   * Called on every provider.stream() invocation for non-code modes.
   */
  private prepareMessagesForProvider(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
      if (msg.role === 'tool_result') {
        // Strip the <tool_result ...> XML wrapper — the model needs the inner content
        // (file contents, command output, notes) but not the XML namespace.
        const inner = msg.content
          .replace(/<tool_result[^>]*>\n?/g, '')
          .replace(/\n?<\/tool_result>/g, '')
          .trim();
        return { role: 'user' as const, content: inner };
      }
      // Strip residual control patterns from any other message role
      const clean = msg.content
        .replace(/\x00TOOL:[^\x00]*\x00/g, '[tool call]')
        .replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '[tool result]');
      if (clean !== msg.content) {
        return { ...msg, content: clean };
      }
      return msg;
    });
  }

  private sanitiseAssistantText(text: string): string {
    return text
      // Strip [write_file: path (N chars)] style labels
      .replace(/\[(?:write_file|edit_file|read_file|list_files|run_command)[^\]]*\]/g, '')
      // Strip null-byte tool sentinels: \x00TOOL:name:{...}\x00
      .replace(/\x00TOOL:[^\x00]*\x00/g, '')
      // Strip <tool_result ...>...</tool_result> XML blocks
      .replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '')
      // Strip [SYSTEM ERROR] prefixes used in runtime rejections
      .replace(/\[SYSTEM ERROR\][^\n]*/g, '')
      // Strip [Batch: N/M done. ...] progress lines (runtime-only)
      .replace(/\[Batch(?:: [^\]]+)?\]/g, '')
      // Strip [Milestone] lines
      .replace(/\[Milestone\][^\n]*/g, '')
      // Collapse multiple blank lines to at most two
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
