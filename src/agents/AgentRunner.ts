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
import { authMethodRequiresCredential } from '../providers/AuthSupport';

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
      const needsOwnKey = authMethodRequiresCredential(agentConfig.provider?.auth_method ?? 'api_key');
      if (needsOwnKey) {
        const ownKey = await this.agentManager.getApiKey(agentId);
        if (!ownKey) {
          const def = await this.configManager.readDefaultProvider();
          if (def?.type) {
            const defNeedsKey = authMethodRequiresCredential(def.auth_method ?? 'api_key');
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
    if (!apiKey && authMethodRequiresCredential(effectiveProvider.auth_method)) {
      onText('Credential not configured. Add a per-agent API key/access token in Agent Settings, or set a workspace default provider.');
      return;
    }

    // Start MCP servers in background — they're needed for tool dispatch (not prompt assembly).
    // The promise is awaited later before the first tool call could happen.
    const mcpStartPromise = this.agentManager.startMCPServersForAgent(agentId, this.workspaceRoot);

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

    // ─── Knowledge retrieval (runs in parallel with context pipeline below) ──
    const kbFolders = agentConfig.knowledge?.source_folders ?? [];
    const kbPromise: Promise<EvidencePack | null> = (async () => {
      if (kbFolders.length === 0 || !this.knowledgeManager) { return null; }
      try {
        if (await this.knowledgeManager.hasKnowledgeBase(agentId)) {
          const evidence = await this.knowledgeManager.query(agentId, userMessage, 5);
          if (evidence.chunks.length > 0) {
            turnMemory.addEvidenceSources(evidence.trace.sources);
            onThought({
              type: 'thinking',
              label: `Knowledge: ${evidence.chunks.length} chunks from ${evidence.trace.sources.join(', ')}`,
              detail: `Latency: ${evidence.trace.latencyMs}ms · Sources: ${evidence.trace.sources.join(', ')}`,
              timestamp: new Date(),
            });
          }
          return evidence;
        }
      } catch (err) {
        console.warn(`AgentRunner: Knowledge retrieval failed for ${agentId}:`, err);
      }
      return null;
    })();

    // ─── Context pipeline (parallelized for speed) ────────────────────────────

    // 1. Classify mode — use regex first (instant), then optionally LLM.
    //    OPT-4: When userMode is explicitly set, skip the LLM classifier (2-5s saved).
    let modeDecision = classifyMode(userMessage);

    // Fire independent I/O operations in parallel while mode classification proceeds
    const batchEnforcer = new BatchEnforcer(this.workspaceRoot);
    const archLock = new ArchitectureLock(
      this.workspaceRoot,
      getAppData().architecturePatterns
    );

    // Run these in parallel: project config, workspace type, LLM classifier (if needed)
    const classifierPromise = (async () => {
      if (userMode) { return; }
      const classifierProviderCfg = await this.configManager.readClassifierProvider();
      if (!classifierProviderCfg) { return; }
      const classifierKey = await this.agentManager.getApiKey('__classifier__');
      if (!classifierKey && authMethodRequiresCredential(classifierProviderCfg.auth_method)) { return; }
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
    })();

    const [projectConfig, _detectedWsType] = await Promise.all([
      this.configManager.readProjectConfig(),
      batchEnforcer.detectWorkspaceType(),
      classifierPromise,
    ]);
    const projectName = projectConfig?.project.name ?? '';
    let detectedWorkspaceType: 'greenfield' | 'docs_only' | 'scaffolded' | 'mature' = _detectedWsType;

    const mode: AssistantMode = userMode ?? modeDecision.mode;
    this.toolDispatcher.resetGuardState(mode, true);
    const requestId = `${agentId}-${Date.now()}`;
    const agentLog = new AgentLogger(this.workspaceRoot, agentId);
    agentLog.sessionStart(mode);

    // Wrap onThought so every UI event is also captured in the log file.
    // Uses a separate variable name to avoid parameter reassignment warnings.
    const _origOnThought = onThought;
    const onThoughtLogged: ThoughtCallback = (event) => {
      agentLog.logEvent(
        `[${event.type.toUpperCase()}] ${event.label}`,
        event.detail,
      );
      _origOnThought(event);
    };
    // eslint-disable-next-line no-param-reassign
    onThought = onThoughtLogged;

    const enhancedPipeline = vsConfig.get<boolean>('contextPipeline.enabled', false);

    // ─── Parallel pre-loop setup ─────────────────────────────────────────────
    // Run independent I/O operations concurrently to minimize startup latency.
    // Budget/profile computation is synchronous and runs inline.
    const budget = getModeBudget(mode);
    const _baseProfile = getActiveModelProfile(effectiveProvider);
    const profile = safeInputTokens < _baseProfile.recommendedInputBudget
      ? { ..._baseProfile, recommendedInputBudget: safeInputTokens }
      : _baseProfile;
    const repoMap = loadRepoMap(this.workspaceRoot);
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const retrievalQuery = { text: userMessage, mode, activeFile };

    // Fire all independent async operations at once
    const [gitContext, systemPreamble, , sessionHistoryResult, artifactResults, , , kbEvidence] = await Promise.all([
      // 1. Git status
      this.gitService.getStatus(this.workspaceRoot),
      // 2. System prompt composition
      this.promptComposer.compose(agentConfig, projectName),
      // 3. Skills loading
      this.skillManager.loadAll(),
      // 4. Session history
      this.memoryManager.getSessionHistoryWithMemory(agentId),
      // 5. Artifact registry
      Promise.all([this.loadArtifactRegistryNote(), this.loadArtifactPaths()]),
      // 6. Audit log (fire-and-forget, non-blocking)
      this.auditLogger.logModeClassified(requestId, mode, modeDecision.confidence, modeDecision.userOverride, modeDecision.reason).catch(() => {}),
      // 7. Enhanced pipeline setup (checkpoint, hooks)
      (async () => {
        if (!enhancedPipeline) { return; }
        if (!this.currentCheckpointId) {
          const checkpt = await this.checkpointManager.createCheckpoint('task_start', `Start Task: ${userMessage.substring(0, 25)}`);
          this.currentCheckpointId = checkpt.id;
          turnMemory.addToolResult('system_checkpoint', `A Git Checkpoint was successfully created before this task began (ID: ${checkpt.id}).`);
          onCheckpointCreated?.(checkpt.id, `Task start: ${userMessage.substring(0, 40)}`, []);
        }
        await this.hookEngine.onSessionStart({ mode });
        if (shouldCreatePlan(userMessage, modeDecision)) {
          const newPlan = createPlan(this.workspaceRoot, userMessage.slice(0, 200), [], mode);
          onPlanCreated?.(newPlan);
        }
      })(),
      // 8. Knowledge retrieval (already started above)
      kbPromise,
    ]);

    if (gitContext.state !== "clean" && enhancedPipeline) {
      onThought({ type: 'thinking', label: `Repository is dirty (${gitContext.state}). Extracting Git snapshot.`, timestamp: new Date() });
    }

    const [artifactNote, registeredArtifactPaths] = artifactResults;

    // ─── Context retrieval (depends on repoMap + budget, but independent of above) ─
    const candidates = await retrieveCandidates(
      retrievalQuery,
      { workspaceRoot: this.workspaceRoot, repoMap, activeFilePath: activeFile, agentId },
      Math.min(budget.retrievedContext, Math.floor(safeInputTokens * 0.2)),
    );

    const candidatePaths = candidates.map(c => c.path || '').filter(Boolean);
    if (gitContext && gitContext.changedPaths) {
      gitContext.changedPaths.forEach(cp => candidatePaths.push(cp.path));
    }

    const instructions = resolveInstructions(this.workspaceRoot, candidatePaths);
    const envelope = buildContextEnvelope(candidates, mode);
    const enforcement = enforcePreflightBudget(envelope, budget, profile);
    const effectiveEnvelope = enforcement.envelope;

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
    agentLog.logSystemPrompt(fullSystem, agentConfig.system_prompt_files ?? []);

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
    //    Session history, artifact note/paths already loaded in parallel above.
    const sessionHistory = sessionHistoryResult;

    const bootstrapContext = ''; // kept for measureRequestSize compat — pipeline handles context
    const retrievalContext = ''; // kept for measureRequestSize compat — pipeline handles context

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

    // ─── OPT-2: Pre-load file references from user message ──────────────────
    // When the user names specific files (e.g. "modify clock.html", "create app.js"),
    // pre-read existing files into resolvedInputContents so the model can skip
    // the list_files → read_file discovery iterations entirely.
    const isLikelyContinue = /^(continue|proceed|go ahead|why did you stop|keep going)/i.test(userMessage.trim());
    if (mode === 'code' && !isLikelyContinue) {
      // Extract filenames: match patterns like "file.ext", "src/foo/bar.ts", etc.
      const fileRefPattern = /(?:^|\s|["'`(])([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,10})(?=[\s"'`),.:;!?]|$)/g;
      const mentionedFiles = new Set<string>();
      let fileMatch: RegExpExecArray | null;
      while ((fileMatch = fileRefPattern.exec(userMessage)) !== null) {
        const candidate = fileMatch[1].replace(/\\/g, '/');
        // Filter out URLs, version numbers, and common non-file patterns
        if (candidate.includes('://') || /^\d+\.\d+/.test(candidate)) { continue; }
        // Filter out common non-file extensions
        if (/\.(com|org|net|io|ai)$/i.test(candidate)) { continue; }
        mentionedFiles.add(candidate);
      }

      if (mentionedFiles.size > 0) {
        const MAX_STORED_CONTENT_CHARS = 6000;
        const MAX_TOTAL_STORED_CHARS = 24000;
        execState.resolvedInputContents ??= {};

        for (const filePath of mentionedFiles) {
          const normalizedPath = this.normalizeWorkspacePath(filePath);
          // Skip files already resolved from a prior session
          if (execState.resolvedInputs.includes(normalizedPath)) { continue; }
          if (execState.resolvedInputContents[normalizedPath]) { continue; }

          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot, filePath);
          try {
            const content = await fs.readFile(absPath, 'utf8');
            // File exists — pre-load it
            stateManager.markFileRead(execState, normalizedPath, content);
            this.toolDispatcher.cacheReadResult(filePath, content);
            const currentTotal = Object.values(execState.resolvedInputContents)
              .reduce((sum, c) => sum + c.length, 0);
            if (currentTotal + Math.min(content.length, MAX_STORED_CONTENT_CHARS) <= MAX_TOTAL_STORED_CHARS) {
              execState.resolvedInputContents[normalizedPath] =
                content.slice(0, MAX_STORED_CONTENT_CHARS);
            }
            agentLog.logEvent('FILE_PRELOAD', `Pre-loaded "${normalizedPath}" (${content.length} chars) from user message reference`);
            onThought({ type: 'thinking', label: `Pre-loaded ${normalizedPath} (${content.length} chars)`, timestamp: new Date() });
          } catch {
            // File doesn't exist — not an error, the model will create it
            agentLog.logEvent('FILE_PRELOAD_SKIP', `"${normalizedPath}" does not exist (will be created)`);
          }
        }
      }
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
        // ACTION 14: Validate plan against requirements before approval
        const isValid = await this.validatePlanAgainstRequirements(planPath, execState);
        if (isValid) {
          stateManager.markPlanApproved(execState, planPath);
          stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });
        } else {
          onThought?.({
            type: 'error',
            label: `[Plan validation] Plan at ${planPath} does not match requirements — not approved`,
            timestamp: new Date(),
          });
        }
      }
    }

    // FIX 4: Pre-load approved plan content into resolvedInputContents at code-mode start.
    // This prevents the model from trying to re-read the plan file at the start of
    // every code-mode session.
    if (mode === 'code' && execState.approvedPlanPath) {
      const planPath = execState.approvedPlanPath;
      execState.resolvedInputContents ??= {};
      const alreadyLoaded = execState.resolvedInputContents[planPath];
      if (!alreadyLoaded) {
        try {
          const absPath = path.isAbsolute(planPath)
            ? planPath
            : path.join(this.workspaceRoot, planPath);
          const planContent = await fs.readFile(absPath, 'utf8');
          execState.resolvedInputContents[planPath] = planContent.slice(0, 6000);
          // Seed the read cache so ToolDispatcher knows this file was read
          this.toolDispatcher.cacheReadResult(planPath, planContent);
          stateManager.markFileRead(execState, planPath, planContent);
        } catch {
          // Plan file missing from disk — clear the approval
          execState.approvedPlanPath = undefined;
        }
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

    // detectedWsType alias for backward compat within the loop
    const detectedWsType: typeof detectedWorkspaceType = detectedWorkspaceType;

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

    // OPT-5: Skip compaction entirely when history is empty or very short.
    // shouldCompact already checks messageCount >= 6 and token threshold,
    // but we add an explicit fast-path to avoid even estimating tokens on fresh sessions.
    if (sessionHistory.length > 0 && historyTokens > 0 && shouldCompact(historyTokens, profile, sessionHistory.length)) {
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
    const sessionStartTime = Date.now();
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
    // OPT-6: Reduced from 2 to 1 — each retry costs a full LLM round-trip.
    // If the model narrates instead of acting after 1 nudge, further nudges rarely help.
    const MAX_NUDGE_RETRIES = 1;
    // Phase 5.2 — Silent reprompt counter: max 1 reprompt before treating as blocked
    let silentRepromptCount = 0;
    const MAX_SILENT_REPROMPTS = 1;
    // Bug-fix004 item 15 — ProgressGuard: track productive vs non-productive turns
    const progressGuard = new ProgressGuard();
    // #15 — Milestone stopping: pause the session every N writes so the agent
    // does not attempt to scaffold an entire project in one run.
    const milestoneWriteSize = vsConfig.get<number>('agent.milestoneWriteSize', 8);
    let nextMilestoneAt = milestoneWriteSize;

    // OPT-1: Track per-path artifact guard rejections so we can auto-recover on 2nd attempt.
    const artifactGuardHits = new Map<string, number>();

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

    // FIX 1: Split system prompt — send full on first iteration, compact thereafter.
    const { volatile: volatileSystemPrompt } = promptAssembler.splitSystemPrompt(fullSystem);
    const identityReminder = `You are ${agentConfig.name} in ${mode} mode. Follow all prior engineering principles.`;
    const compactSystem = volatileSystemPrompt
      ? `${identityReminder}\n\n${volatileSystemPrompt}`
      : fullSystem; // fallback if no split marker found
    let isFirstIteration = true;

    // FIX 7: Ready-to-execute gate — confirm the model has input files before entering
    // the loop so it doesn't reflexively try to read files it already has.
    if (mode === 'code') {
      const hasFileContents = Object.keys(execState.resolvedInputContents ?? {}).length > 0;
      const hasPlan = !!execState.approvedPlanPath;
      const hasRequirements = (execState.resolvedInputSummaries ?? [])
        .some(s => s.kind === 'requirements' || s.kind === 'plan');

      if (hasFileContents || hasPlan || hasRequirements) {
        // Ready: inject explicit confirmation so the model does not re-read
        const loadedFiles = Object.keys(execState.resolvedInputContents ?? {}).join(', ');
        if (loadedFiles) {
          messages.push({
            role: 'system',
            content: `[READY] You have all required input files loaded: ${loadedFiles}. Begin writing immediately. Do not read any files.`,
          });
        }
        stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
      } else {
        // Not ready — allow limited discovery then force write
        messages.push({
          role: 'system',
          content: `[Discovery budget: 2 reads maximum. Read the most important file, then write.]`,
        });
      }
    }

    // Ensure MCP servers are ready before the first tool call
    await mcpStartPromise;

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
      // Track where this iteration's tools start in the cumulative toolsUsed array,
      // so inferStepContract sees only this turn's tools, not the full session.
      const turnToolStartIdx = toolsUsed.length;

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

      // Deterministic pre-LLM dispatch gate.
      // If we already know the next tool call or are in forced-write recovery,
      // do not ask the LLM to decide whether to rediscover.
      if (mode === 'code') {
        const phase = stateManager.getExecutionPhase(execState);
        const shouldForceWrite = phase === 'WRITE_ONLY' || (execState.blockedReadCount ?? 0) >= 2;
        const preLlmNtc = execState.nextToolCall;

        if (preLlmNtc && !VIRTUAL_TOOLS.has(preLlmNtc.tool)) {
          contextCostTracker.recordSkippedLLMCall();
          onThought?.({ type: 'thinking', label: `[Pre-LLM dispatch] ${preLlmNtc.tool}`, timestamp: new Date() });
          const preResult = await this.toolDispatcher.dispatch(
            { id: `prellm-${Date.now()}`, name: preLlmNtc.tool, input: preLlmNtc.input as Record<string, unknown> },
            agentId, onApproval, onDiff, onThought,
          );
          stateManager.markToolExecuted(execState, preLlmNtc.tool, (preLlmNtc.input as Record<string, unknown>).path as string | undefined, preResult.text.slice(0, 150));
          stateManager.clearNextToolCall(execState);
          stateManager.save(agentId, execState).catch(() => { /* non-fatal */ });

          let truncated = preResult.text;
          if (preResult.text.length > 8000) {
            truncated = `${preResult.text.slice(0, 8000)}\n[truncated]`;
          }
          const preMsg: ChatMessage = { role: 'tool_result', content: `<tool_result name="${preLlmNtc.tool}">
${truncated}
</tool_result>` };
          messages.push(preMsg);
          currentStepToolResults.push(preMsg);
          calledATool = true;
          continueLoop = true;
          iterationCount++;
          continue;
        }

        if (shouldForceWrite) {
          stateManager.setExecutionPhase(execState, 'WRITE_ONLY');
          this.toolDispatcher.setExecutionPhase('WRITE_ONLY');
          silentExecution = true;
          effectiveUserContent = 'WRITE_ONLY phase: generate and call write_file or edit_file now. Do not call read_file, list_files, search_files, or glob_files.';
        }
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

            // FIX 8: Log recovery
            agentLog.logRecovery(trigger, true, result.summary);

            // FIX 10: In plan mode, inject all stored file contents so forced writes
            // are based on actual content, not filename guessing.
            if (trigger === 'REPEATED_BLOCKED_READS' && mode === 'plan') {
              const allContents = Object.entries(execState.resolvedInputContents ?? {})
                .map(([p, c]) => `[${p}]:\n${c}`)
                .join('\n\n---\n\n');
              if (allContents) {
                messages.push({
                  role: 'system',
                  content: `[FORCED WRITE MODE] You must write the plan now. Here are the input files you previously read:\n\n${allContents}\n\nBase your plan on THIS content, not on filenames.`,
                });
              }
            }

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
                agentLog.logDeterministicDispatch(ntc.tool, (ntc.input as Record<string, unknown>).path as string | undefined, 'strategy-switch after recovery');
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
          agentLog.logDeterministicDispatch(bypassNtc.tool, (bypassNtc.input as Record<string, unknown>).path as string | undefined, 'blocked-read bypass');
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
            agentLog.logDeterministicDispatch(dd9Ntc.tool, (dd9Ntc.input as Record<string, unknown>).path as string | undefined, 'DD9 direct dispatch');
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
      let stepContractKind: 'discover' | 'mutate' | 'validate' = 'discover';
      if (mode === 'code') {
        // DD7: Build compact context packet from execution state for prompt assembly.
        const contextPacket = contextPacketBuilder.build(
          execState, detectedWsType, undefined, effectiveUserContent
        );
        const compactSummary = contextPacket.stateSummary;
        const compactWorkspace = contextPacket.workspaceSummary;

        const stepContract = this.computeStepContract(execState);
        stepContractKind = stepContract.kind;
        const toolResultsForPrompt = stepContract.kind === 'mutate'
          ? currentStepToolResults.slice(-2)
          : [...currentStepToolResults];

        messagesForProvider = promptAssembler.assembleMessages({
          systemPrompt: isFirstIteration ? fullSystem : compactSystem,
          executionStateSummary: compactSummary,
          workspaceSummary: compactWorkspace,
          currentInstruction: effectiveUserContent,
          currentStepToolResults: toolResultsForPrompt,
          milestoneSummary: execState.lastExecutedTool
            ? `Last tool: ${execState.lastExecutedTool}`
            : undefined,
          // Phase 8.4 — inject template-specific skill fragments
          activeSkills: activeSkills.length > 0 ? activeSkills : undefined,
          // FIX 2c / FIX 9: inject resolved file contents so model never re-reads
          resolvedFileContents: contextPacket.resolvedFileContents || undefined,
        });
        messagesForProvider.push({ role: 'system', content: stepContract.instruction });
        agentLog.logAction('STEP_CONTRACT', `${stepContract.kind}: ${stepContract.summary}`);
        isFirstIteration = false;

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
          stateManager.getExecutionPhase(execState),
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
        agentLog.logContextCost(iterationCount, {
          systemPromptTokens: costEntry.systemPromptTokens,
          stateTokens: costEntry.executionStateTokens,
          fileContentTokens: costEntry.skillFragmentTokens,
          toolResultTokens: costEntry.toolResultTokens,
          userMessageTokens: costEntry.currentInstructionTokens,
          totalTokens: costEntry.totalTokens,
        });

        // Reset after use — tool results from THIS iteration will repopulate it below
        currentStepToolResults.length = 0;
      } else {
        // Non-code modes: sanitise tool_result roles
        messagesForProvider = this.prepareMessagesForProvider(messages);
      }
      // FIX 8: Log provider request and execution state at each iteration
      agentLog.logProviderRequest(iterationCount, messagesForProvider, mode);
      agentLog.logExecutionState(iterationCount, execState);

      const toolsForTurn = mode === 'code'
        ? this.filterToolsByStepContract(this.filterToolsByMode(tools, mode), stepContractKind)
        : this.filterToolsByMode(tools, mode);
      for await (const event of provider.stream(messagesForProvider, toolsForTurn, actualMaxOutputTokens)) {
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
          const toolInput = (event.input as Record<string, unknown>) ?? {};
          const toolCallPath = toolInput.path as string | undefined;
          const loopTarget = stateManager.buildLoopTarget(event.name, toolInput);
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
            const rewrittenContent = (event.input as Record<string, unknown>)?.content;
            if (typeof rewrittenContent === 'string') {
              // Preserve progress: repeated write_file attempts on the same path are
              // auto-routed to edit_file instead of being hard-rejected.
              const redirectedResult = await this.toolDispatcher.dispatch(
                {
                  id: `redirect-${Date.now()}`,
                  name: 'edit_file',
                  input: { path: toolCallPath, content: rewrittenContent },
                },
                agentId,
                onApproval,
                onDiff,
                onThought,
              );
              const redirectNote = `[AUTO-REDIRECT] write_file→edit_file for "${toolCallPath}" because it was already written this task.`;
              const redirectedText = `${redirectedResult.text}\n${redirectNote}`;
              agentLog.logToolResult('edit_file', redirectedText);
              turnMemory.addToolResult('edit_file', redirectedText);
              toolResultContent = `<tool_result name="edit_file">\n${this.truncateToolResult(redirectedText, 'edit_file', iterationCount, toolCallPath)}\n</tool_result>`;
              stateManager.markToolExecuted(execState, 'edit_file', toolCallPath, redirectedText.slice(0, 150));
              stateManager.markProgress(execState);
              if (execState.executionPhase === 'WRITE_ONLY') {
                stateManager.setExecutionPhase(execState, 'EXECUTING_STEP');
                this.toolDispatcher.setExecutionPhase('EXECUTING_STEP');
              }
            } else {
              const pathList = Array.from(writtenPaths).map(p => `"${p}"`).join(', ');
              const rejection = `[SYSTEM ERROR] write_file REJECTED: "${toolCallPath}" was already written this task. The file has NOT been changed. You MUST use edit_file for any corrections to existing files. Written paths: ${pathList}. Proceed with remaining tasks or summarise.`;
              agentLog.logToolResult(event.name, rejection);
              turnMemory.addToolResult(event.name, rejection);
              toolResultContent = `<tool_result name="${event.name}" status="error">\n${rejection}\n</tool_result>`;
              onThought({ type: 'error', label: `Rewrite blocked: ${toolCallPath}`, detail: rejection, timestamp: new Date() });
            }
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
            // ─── OPT-1+3: Smart cross-session artifact guard ─────────────────
            // File was created in a PREVIOUS session. Instead of hard-blocking
            // (which causes the model to retry write_file until halted), we:
            //   1st hit: Read the existing file, inject content, guide model to edit_file.
            //   2nd hit: Allow the write_file through (model clearly intends a full rewrite).
            const normalizedGuard = this.normalizeWorkspacePath(toolCallPath);
            const hitCount = (artifactGuardHits.get(normalizedGuard) ?? 0) + 1;
            artifactGuardHits.set(normalizedGuard, hitCount);

            if (hitCount >= 2) {
              // OPT-3: 2nd+ attempt — model clearly wants to overwrite. Allow it.
              agentLog.logEvent('ARTIFACT_GUARD_OVERRIDE', `Allowing write_file on "${normalizedGuard}" (attempt #${hitCount})`);
              onThought({ type: 'thinking', label: `Artifact guard: allowing rewrite of ${normalizedGuard} (attempt #${hitCount})`, timestamp: new Date() });
              // Remove from registered set so subsequent writes in this session aren't blocked.
              registeredArtifactPaths.delete(normalizedGuard);
              // Fall through to normal dispatch below by NOT setting toolResultContent here.
              // We need to re-dispatch the tool call.
              const writeResult = await this.toolDispatcher.dispatch(
                event, agentId, onApproval, onDiff, onThought
              );
              agentLog.logToolResult(event.name, writeResult.text);
              turnMemory.addToolResult(event.name, writeResult.text);
              toolResultContent = `<tool_result name="${event.name}">\n${writeResult.text}\n</tool_result>`;
              if (writeResult.status === 'success' && writeResult.text.startsWith('File written')) {
                writtenPaths.add(toolCallPath);
                toolPathCounts.clear();
                const pathList = Array.from(writtenPaths).map(p => `"${p}"`).join(', ');
                toolResultContent += `\n\nFiles written this task: ${pathList}. Use edit_file for any corrections to these paths.`;
                this.recordArtifact(agentId, toolCallPath).catch(() => { /* non-fatal */ });
                stateManager.markFileWritten(execState, normalizedGuard);
                stateManager.markProgress(execState);
              }
            } else {
              // OPT-1: 1st attempt — auto-read the existing file and inject content
              // so the model has context to use edit_file (or retry as full rewrite).
              let existingContent = '';
              const absPath = path.isAbsolute(toolCallPath)
                ? toolCallPath
                : path.join(this.workspaceRoot, toolCallPath);
              try {
                existingContent = await fs.readFile(absPath, 'utf8');
              } catch {
                existingContent = '[could not read existing file]';
              }

              // Cache the content so the model has it available
              if (existingContent && existingContent !== '[could not read existing file]') {
                this.toolDispatcher.cacheReadResult(toolCallPath, existingContent);
                stateManager.markFileRead(execState, normalizedGuard, existingContent);
                // Store in resolvedInputContents for context injection
                const MAX_STORED_CONTENT_CHARS = 6000;
                execState.resolvedInputContents ??= {};
                execState.resolvedInputContents[normalizedGuard] =
                  existingContent.slice(0, MAX_STORED_CONTENT_CHARS);
              }

              const contentPreview = existingContent.length > 500
                ? `${existingContent.slice(0, 500)}\n… [${existingContent.length} chars total]`
                : existingContent;
              const guidance = `[ARTIFACT GUARD] "${normalizedGuard}" already exists (${existingContent.length} chars). ` +
                `The file has been auto-loaded into context. You have two options:\n` +
                `1. Use edit_file to modify specific parts.\n` +
                `2. Call write_file again with the full new content to overwrite it.\n\n` +
                `Current file content:\n${contentPreview}`;
              agentLog.logToolResult(event.name, `artifact guard: auto-read ${normalizedGuard} (${existingContent.length} chars)`);
              turnMemory.addToolResult(event.name, guidance);
              toolResultContent = `<tool_result name="${event.name}" status="error">\n${guidance}\n</tool_result>`;
              onThought({ type: 'thinking', label: `Artifact guard: auto-loaded ${normalizedGuard} into context`, detail: `${existingContent.length} chars`, timestamp: new Date() });
            }
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
            const toolPathKey = `${event.name}:${loopTarget ?? ''}`;
            const toolPathCount = (toolPathCounts.get(toolPathKey) ?? 0) + 1;
            toolPathCounts.set(toolPathKey, toolPathCount);

            let toolResult: DispatchResult;

            // Pre-dispatch budget guard: block the Nth consecutive read BEFORE dispatching
            // so we don't waste an API call on a read that will just be overwritten.
            const isPreDispatchReadBlock =
              (execState.executionPhase ?? 'DISCOVERING') !== 'WRITE_ONLY' &&
              ['read_file', 'list_files', 'search_files', 'glob_files', 'grep_content'].includes(event.name) &&
              consecutiveReadCount >= 2 && writtenPaths.size === 0;

            // OPT-7: Aligned tool list with isPreDispatchReadBlock (was missing glob_files, grep_content)
            const shouldForceWriteOnlyForLoop =
              (execState.executionPhase ?? 'DISCOVERING') !== 'WRITE_ONLY' &&
              (toolPathCount >= 2 || isPreDispatchReadBlock) &&
              ['read_file', 'list_files', 'search_files', 'glob_files', 'grep_content'].includes(event.name);
            if (shouldForceWriteOnlyForLoop) {
              // FIX 3b: Hard state transition to WRITE_ONLY — no more reads allowed.
              stateManager.setExecutionPhase(execState, 'WRITE_ONLY');
              this.toolDispatcher.lockDiscovery();
              this.toolDispatcher.setExecutionPhase('WRITE_ONLY');

              // Inject the file content the model is trying to read (if stored)
              const storedContent = (event.name === 'read_file' && toolCallPath)
                ? execState.resolvedInputContents?.[this.normalizeWorkspacePath(toolCallPath)]
                : undefined;
              const contentInjection = storedContent
                ? `\n\nHere is the content you are trying to read:\n${storedContent}`
                : '';

              toolResult = {
                text: `[READ BLOCKED] Repeated ${event.name} call on "${loopTarget ?? event.name}". Phase is now WRITE_ONLY. All further reads will be rejected. Write the next file now.${contentInjection}`,
                status: 'blocked',
                reasonCode: 'WRITE_ONLY_PHASE',
                toolName: event.name,
                path: loopTarget,
              };
              onThought?.({ type: 'error', label: `Loop detected → WRITE_ONLY: ${event.name}:${loopTarget ?? ''} x${toolPathCount}`, timestamp: new Date() });
              agentLog.logGuardActivation('WRITE_ONLY', event.name, loopTarget, iterationCount);
              agentLog.logPhaseTransition(execState.executionPhase ?? 'DISCOVERING', 'WRITE_ONLY', `loop on ${event.name}:${loopTarget ?? ''}`);
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
                const shouldTrackBlockedRead = (
                  toolResult.reasonCode === 'ALREADY_READ_UNCHANGED' ||
                  toolResult.reasonCode === 'LOOP_DETECTED' ||
                  toolResult.reasonCode === 'WRITE_ONLY_PHASE' ||
                  toolResult.reasonCode === 'DISCOVERY_LOCKED' ||
                  toolResult.reasonCode === 'DISCOVERY_BUDGET_EXHAUSTED'
                );
                if (shouldTrackBlockedRead) {
                  const normBlockedPath = this.normalizeWorkspacePath(toolCallPath ?? loopTarget ?? event.name);
                  if (!blockedReadPaths.has(normBlockedPath)) {
                    blockedReadPaths.add(normBlockedPath);
                    stateManager.incrementBlockedRead(execState, normBlockedPath);
                  }
                  // DD4: Record tool loop for same-tool detection
                  stateManager.recordToolLoop(execState, event.name, loopTarget);
                }
              }
              if (toolResult.status === 'success') {
                // Only record successful executions as ground-truth state.
                stateManager.markToolExecuted(execState, event.name, toolCallPath, toolResult.text.slice(0, 150));
                // DD4: Reset tool loop on success
                stateManager.resetToolLoop(execState);
                if (event.name === 'read_file' && toolCallPath) {
                  // ACTION 13: Pass content so structured facts can be extracted
                  stateManager.markFileRead(
                    execState,
                    this.normalizeWorkspacePath(toolCallPath),
                    toolResult.text  // pass content for structured summary extraction
                  );
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

                  // FIX 2: Store full file content (budget-capped) so it survives
                  // across iterations and the model never needs to re-read.
                  const MAX_STORED_CONTENT_CHARS = 6000;
                  const MAX_TOTAL_STORED_CHARS = 24000;
                  execState.resolvedInputContents ??= {};
                  const currentTotal = Object.values(execState.resolvedInputContents)
                    .reduce((sum, c) => sum + c.length, 0);
                  if (currentTotal + Math.min(toolResult.text.length, MAX_STORED_CONTENT_CHARS) <= MAX_TOTAL_STORED_CHARS) {
                    const normalizedPath = this.normalizeWorkspacePath(toolCallPath);
                    execState.resolvedInputContents[normalizedPath] =
                      toolResult.text.slice(0, MAX_STORED_CONTENT_CHARS);
                  }
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

            // ACTION 8: Tiered truncation — full on first read, digest on subsequent
            const resultStr = toolResult.text;
            const truncatedResult = this.truncateToolResult(
              resultStr,
              event.name,
              iterationCount,
              toolCallPath
            );
            toolResultContent = `<tool_result name="${event.name}">\n${truncatedResult}\n</tool_result>`;

            // ─── OPT-7: Consolidated discovery budget counter ─────────────────
            // Track consecutive reads/writes for the pre-dispatch guard (layer 2).
            // The post-dispatch override (old layer 3) has been removed — the
            // pre-dispatch guard at consecutiveReadCount >= 2 and the ToolDispatcher's
            // WRITE_ONLY/discoveryLocked checks (layer 1) handle blocking.
            const isReadOnlyTool = ['read_file', 'list_files', 'search_files', 'glob_files', 'grep_content'].includes(event.name);
            const isWriteOrActionTool = ['write_file', 'edit_file', 'run_command', 'replace_range', 'multi_edit'].includes(event.name);
            if (isReadOnlyTool) {
              consecutiveReadCount++;
            } else if (isWriteOrActionTool) {
              consecutiveReadCount = 0;
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

              // Verify all written files are still on disk every 10 writes
              if (writtenPaths.size % 10 === 0) {
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

            // FIX 5: After plan-mode write, validate that the plan references the objective.
            if (mode === 'plan' && event.name === 'write_file' && toolResult.status === 'success') {
              const writtenContent = ((event.input as Record<string, unknown>)?.content as string) ?? '';
              const objective = execState.primaryObjective ?? execState.objective;
              const objectiveWords = objective.toLowerCase().split(/\s+/).filter(w => w.length > 4);
              const planLower = writtenContent.toLowerCase();
              const matches = objectiveWords.filter(w => planLower.includes(w));
              const overlapRatio = matches.length / Math.max(objectiveWords.length, 1);
              if (overlapRatio < 0.2 && objectiveWords.length > 2) {
                toolResultContent += `\n\n[WARNING] The plan you wrote has low overlap with the primary objective: "${objective.slice(0, 200)}". Review and revise the plan to match the actual requirements.`;
                stateManager.setArtifactStatus(execState,
                  this.normalizeWorkspacePath(toolCallPath!), 'drafted');
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

              // Phase 7.1 — ConsistencyValidator (validatorEnforcement)
              // Run every 10 writes instead of every write to reduce overhead.
              if (vsConfig.get<boolean>('validatorEnforcement', false) && MUTATION_TOOLS.has(event.name) && writtenPaths.size % 10 === 0) {
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
          // Hooks run per-edit, but ValidationService is deferred to end-of-session
          // to avoid running lint/test/tsc on every single write (major perf bottleneck).
          if (enhancedPipeline && (event.name.includes('write') || event.name.includes('edit'))) {
            await this.hookEngine.onAfterEdit([event.name], { mode });
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

      // ACTION 15: Structured turn logging
      agentLog.logTurnSummary({
        turn: iterationCount,
        phase: stateManager.getExecutionPhase(execState),
        inputTokens: 0,
        outputTokens: 0,
        cacheHit: false,
        toolCalled: toolsUsed.length > 0 ? toolsUsed[toolsUsed.length - 1] : undefined,
        toolPath: undefined,
        toolStatus: calledATool ? 'dispatched' : 'none',
        toolReasonCode: undefined,
        writtenThisTurn: [],
        cumulativeWrites: writtenPaths.size,
        cumulativeReads: execState.resolvedInputs.length,
        blockedReads: execState.blockedReadCount ?? 0,
        systemPromptTokens: estimateTokens(fullSystem),
        contextPacketTokens: 0,
        toolResultTokens: estimateTokens(currentStepToolResults.map(m => m.content).join('')),
        llmCallSkipped: false,
        deterministicDispatch: false,
      });

      // ACTION 22: Auto-halt on sustained inefficiency.
      if (iterationCount >= 3) {
        const recentEntries = contextCostTracker.getRecentEntries(3);
        if (recentEntries.length >= 3) {
          const totalIn = recentEntries.reduce((sum, e) => sum + e.totalTokens, 0);
          const totalOut = recentEntries.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
          const efficiency = totalIn > 0 ? totalOut / totalIn : 0;

          if (efficiency < 0.02 && writtenPaths.size === 0) {
            onThought?.({
              type: 'error',
              label: `[Efficiency guard] ${(efficiency * 100).toFixed(1)}% over last 3 turns — halting`,
              timestamp: new Date(),
            });
            stateManager.setRunPhase(execState, 'BLOCKED_BY_VALIDATION');
            stateManager.save(agentId, execState).catch(() => {});
            onText(
              '\n\nSession halted: token efficiency below 2% for 3 consecutive turns with no files written. ' +
                'This indicates the agent is stuck. Review the execution state or provide more specific instructions.'
            );
            continueLoop = false;
          }
        }
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

      // If the model emitted file content in plain assistant text (without tool calls),
      // salvage it by materialising those files directly via write_file/edit_file tools.
      if (!calledATool && turnAssistantText) {
        const persistedCount = await this.persistAssistantGeneratedFiles(
          turnAssistantText,
          agentId,
          writtenPaths,
          messages,
          currentStepToolResults,
          execState,
          stateManager,
          toolsUsed,
          onApproval,
          onDiff,
          onThought,
        );
        if (persistedCount > 0) {
          calledATool = true;
          continueLoop = true;
          turnAssistantText = `${turnAssistantText}\n\n[Auto-persisted ${persistedCount} file block(s) from assistant output.]`;
          onThought?.({
            type: 'thinking',
            label: `Auto-persisted ${persistedCount} file block(s) from assistant output`,
            timestamp: new Date(),
          });
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
        // Use only the tools from this iteration, not the cumulative session list.
        const turnTools = toolsUsed.slice(turnToolStartIdx);
        const contract = inferStepContract(turnTools, turnAssistantText || lastAssistantText, execState.runPhase ?? 'RUNNING');
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

    // ACTION 15: Session summary
    agentLog.logSessionSummary({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTurns: iterationCount,
      uniqueFilesWritten: Array.from(writtenPaths),
      uniqueFilesRead: execState.resolvedInputs,
      loopDetections: execState.blockedReadCount ?? 0,
      discoveryBudgetExceeded: 0,
      recoveryAttempts,
      llmCallsSkipped: contextCostTracker.getSkippedCount(),
      deterministicDispatches: 0,
      durationMs: Date.now() - sessionStartTime,
      tokenEfficiency: 0,
      fsmPhases: [],
    });

    // ─── End-of-session validation (deferred from per-write hot path) ──────────
    // Run lint/test/tsc once after the loop instead of after every write.
    if (enhancedPipeline && writtenPaths.size > 0) {
      onThought({ type: 'thinking', label: 'Running end-of-session validation...', timestamp: new Date() });
      const val = await this.validationService.run(Array.from(writtenPaths));
      if (!val.ok) {
        onThought({
          type: 'error',
          label: `Validation found ${val.diagnostics.length} issue(s)`,
          detail: val.diagnostics[0]?.message || 'Unknown Failure',
          timestamp: new Date()
        });
        const valNote = `\n\n**Validation issues detected:** ${val.diagnostics.map(d => d.message).join('; ')}`;
        onText(valNote);
        fullResponse += valNote;
      } else {
        this.currentCheckpointId = null;
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

    // ─── Session completion report ────────────────────────────────────────────
    // Show a report when the agent used tools or hit a non-running state.
    // Skip for pure text-only responses (simple Q&A) to avoid noise.
    const shouldShowReport = toolsUsed.length > 0 || (execState.runPhase ?? 'RUNNING') !== 'RUNNING';
    if (shouldShowReport) {
      const sessionDuration = Date.now() - sessionStartTime;
      const durationSec = Math.round(sessionDuration / 1000);
      const written = Array.from(writtenPaths);
      const readCount = execState.resolvedInputs?.length ?? 0;
      const batchPlanned = execState.plannedFileBatch ?? [];
      const batchCompleted = execState.completedBatchFiles ?? [];
      const batchRemaining = batchPlanned.filter((f: string) => !batchCompleted.includes(f));
      const phase = execState.runPhase ?? 'RUNNING';

      const reportLines: string[] = [];
      reportLines.push('\n\n---');
      reportLines.push('**Session Report**');

      // What was done
      if (written.length > 0) {
        const fileList = written.length <= 8
          ? written.map(f => `\`${f}\``).join(', ')
          : written.slice(0, 6).map(f => `\`${f}\``).join(', ') + ` and ${written.length - 6} more`;
        reportLines.push(`- **Files written/edited:** ${written.length} — ${fileList}`);
      }
      if (readCount > 0) {
        reportLines.push(`- **Files read:** ${readCount}`);
      }
      if (toolsUsed.length > 0) {
        // Deduplicate and count tool usage
        const toolCounts = new Map<string, number>();
        for (const t of toolsUsed) {
          toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
        }
        const toolSummary = Array.from(toolCounts.entries())
          .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
          .join(', ');
        reportLines.push(`- **Tool operations:** ${toolsUsed.length} (${toolSummary})`);
      }
      reportLines.push(`- **Iterations:** ${iterationCount} | **Duration:** ${durationSec}s`);

      // Batch progress
      if (batchPlanned.length > 0) {
        reportLines.push(`- **Batch progress:** ${batchCompleted.length}/${batchPlanned.length} files completed`);
        if (batchRemaining.length > 0) {
          const remainList = batchRemaining.length <= 5
            ? batchRemaining.map((f: string) => `\`${f}\``).join(', ')
            : batchRemaining.slice(0, 4).map((f: string) => `\`${f}\``).join(', ') + ` and ${batchRemaining.length - 4} more`;
          reportLines.push(`- **Remaining in batch:** ${remainList}`);
        }
      }

      // What does the user need to do (if anything)?
      if (phase === 'WAITING_FOR_USER_INPUT') {
        const reason = execState.waitStateReason ?? '';
        reportLines.push('');
        reportLines.push('**Action required from you:**');
        if (reason) {
          reportLines.push(`> ${reason}`);
        } else if (batchRemaining.length > 0) {
          reportLines.push(`> The agent paused with ${batchRemaining.length} file(s) remaining. Type **continue** to resume writing the remaining files.`);
        } else {
          reportLines.push('> The agent is waiting for your input. Please provide instructions or feedback to continue.');
        }
      } else if (phase === 'BLOCKED_BY_VALIDATION') {
        reportLines.push('');
        reportLines.push('**Action required from you:**');
        reportLines.push('> The agent is blocked by validation errors. Review the issues above, fix them, and retry.');
      } else if (phase === 'RECOVERY_REQUIRED') {
        reportLines.push('');
        reportLines.push('**Action required from you:**');
        reportLines.push('> The execution state is inconsistent. Run the command **Bormagi: Reset Execution State** and retry.');
      } else if (phase === 'PARTIAL_BATCH_COMPLETE') {
        reportLines.push('');
        reportLines.push('**Action required from you:**');
        reportLines.push(`> Batch phase complete (${batchCompleted.length}/${batchPlanned.length} files). Review the written files and type **continue** to proceed with the next batch.`);
      } else if (phase === 'COMPLETED') {
        if (written.length > 0) {
          reportLines.push('');
          reportLines.push('**Status:** Task completed successfully.');
        }
      } else if (iterationCount >= maxToolIterations) {
        reportLines.push('');
        reportLines.push('**Action required from you:**');
        reportLines.push(`> The agent reached the iteration limit (${maxToolIterations}). Type **continue** to resume, or provide new instructions.`);
      }

      const report = reportLines.join('\n');
      onText(report);
      fullResponse += report;
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

  /**
   * Normalize to a canonical workspace-relative path:
   * - Convert backslashes to forward slashes (Windows compat)
   * - Strip absolute workspace root prefix if the model sends one
   * - Strip leading slashes
   */
  private normalizeWorkspacePath(input: string): string {
    let p = input.replace(/\\/g, '/');
    // Strip workspace root prefix if the model sent an absolute path
    const root = this.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(root + '/')) {
      p = p.slice(root.length + 1);
    }
    return p.replace(/^\/+/, '');
  }

  /**
   * Tiered tool result truncation.
   * - First 2 iterations: allow full content (up to 8K) for orientation.
   * - Later iterations: read_file results get a head+tail digest because
   *   the full content should be in resolvedInputs (ACTION 2).
   * - Non-read tools: always cap at 4K.
   */
  private truncateToolResult(
    content: string,
    toolName: string,
    iterationCount: number,
    toolPath?: string,
  ): string {
    // Non-read tools: 4K cap
    if (!['read_file', 'search_files', 'grep_content'].includes(toolName)) {
      return content.length > 4000
        ? content.slice(0, 4000) + '\n[truncated]'
        : content;
    }

    // First 2 iterations: allow full content (up to 8K) for initial orientation
    if (iterationCount <= 2) {
      return content.length > 8000
        ? content.slice(0, 8000) + '\n[truncated — full content stored in resolved inputs]'
        : content;
    }

    // Later iterations: digest only (full content is in resolvedInputs)
    if (content.length > 2000) {
      return (
        content.slice(0, 1000) +
        `\n\n[... ${content.length - 1500} chars omitted — full content in resolved inputs for ${toolPath ?? 'this file'} ...]\n\n` +
        content.slice(-500)
      );
    }

    return content;
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

  /**
   * Validate that a plan file's content aligns with the requirements.
   * Prevents hallucinated plans (e.g., a plan for "requirements management"
   * when the actual requirement is "PDF extraction tool") from being approved.
   *
   * Uses term overlap: if fewer than 30% of key terms from the requirements
   * appear in the plan, the plan is rejected.
   */
  private async validatePlanAgainstRequirements(
    planPath: string,
    execState: ExecutionStateData
  ): Promise<boolean> {
    const reqSummary = (execState.resolvedInputSummaries ?? []).find(
      s => s.kind === 'requirements'
    );
    if (!reqSummary || reqSummary.summary.length < 50) {
      return true; // no requirements to compare against
    }

    try {
      const planContent = await fs.readFile(
        path.join(this.workspaceRoot, planPath),
        'utf8'
      );

      // Extract significant terms (4+ chars) from requirements summary
      const reqTerms = new Set(
        reqSummary.summary.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []
      );

      if (reqTerms.size < 3) return true; // too few terms to compare

      const planLower = planContent.toLowerCase();
      const matches = [...reqTerms].filter(t => planLower.includes(t));
      const overlapRatio = matches.length / reqTerms.size;

      if (overlapRatio < 0.3) {
        return false; // plan does not match requirements
      }

      return true;
    } catch {
      return true; // file not readable — approve by default
    }
  }

  /**
   * Extract markdown file blocks from assistant prose and persist them via tools.
   * This is a safety net for provider turns that render code in chat instead of
   * issuing write_file/edit_file calls.
   */
  private async persistAssistantGeneratedFiles(
    assistantText: string,
    agentId: string,
    writtenPaths: Set<string>,
    messages: ChatMessage[],
    currentStepToolResults: ChatMessage[],
    execState: ExecutionStateData,
    stateManager: ExecutionStateManager,
    toolsUsed: string[],
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    onThought: ThoughtCallback,
  ): Promise<number> {
    const extracted = this.extractFileBlocksFromAssistantText(assistantText);
    if (extracted.length === 0) {
      return 0;
    }

    let persisted = 0;
    for (const file of extracted) {
      const normalizedPath = this.normalizeWorkspacePath(file.path);
      if (!normalizedPath || normalizedPath.startsWith('.bormagi/')) {
        continue;
      }

      const toolName = writtenPaths.has(normalizedPath) ? 'edit_file' : 'write_file';
      const dispatchResult = await this.toolDispatcher.dispatch(
        {
          id: `autopersist-${Date.now()}-${persisted}`,
          name: toolName,
          input: { path: normalizedPath, content: file.content },
        },
        agentId,
        onApproval,
        onDiff,
        onThought,
      );

      const toolMsg: ChatMessage = {
        role: 'tool_result',
        content: `<tool_result name="${toolName}">\n${dispatchResult.text}\n</tool_result>`,
      };
      messages.push(toolMsg);
      currentStepToolResults.push(toolMsg);
      toolsUsed.push(toolName);

      if (dispatchResult.status === 'success') {
        writtenPaths.add(normalizedPath);
        stateManager.markFileWritten(execState, normalizedPath);
        stateManager.markToolExecuted(execState, toolName, normalizedPath, dispatchResult.text.slice(0, 150));
        stateManager.markProgress(execState);
        persisted++;
      }
    }

    return persisted;
  }

  /** Parse assistant markdown for file-oriented code fences. */
  private extractFileBlocksFromAssistantText(text: string): Array<{ path: string; content: string }> {
    const results: Array<{ path: string; content: string }> = [];
    const seen = new Set<string>();

    const push = (pathValue: string, contentValue: string) => {
      const path = pathValue.trim().replace(/^['"`]|['"`]$/g, '');
      const content = contentValue.replace(/\n$/, '');
      if (!path || content.trim().length < 8) {
        return;
      }
      if (!/^[a-zA-Z0-9_./-]+\.[a-zA-Z0-9_-]+$/.test(path)) {
        return;
      }
      if (!seen.has(path)) {
        seen.add(path);
        results.push({ path, content });
      }
    };

    const fileHeaderFence = /(?:^|\n)(?:\*\*\s*)?(?:file|path)\s*:\s*`?([^`\n]+)`?(?:\s*\*\*)?\s*\n```[^\n]*\n([\s\S]*?)```/gim;
    let match: RegExpExecArray | null;
    while ((match = fileHeaderFence.exec(text)) !== null) {
      push(match[1], match[2]);
    }

    const pathFence = /(?:^|\n)```\s*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_-]+)\s*\n([\s\S]*?)```/gm;
    while ((match = pathFence.exec(text)) !== null) {
      push(match[1], match[2]);
    }

    return results;
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

  /**
   * Apply step-contract tool narrowing inside code mode.
   * This reduces read/write oscillation by constraining the tool surface per step.
   */
  private filterToolsByStepContract(
    tools: MCPToolDefinition[],
    contractKind: 'discover' | 'mutate' | 'validate'
  ): MCPToolDefinition[] {
    if (contractKind === 'mutate') {
      const allowed = new Set(['write_file', 'edit_file', 'replace_range', 'multi_edit', 'run_command', 'update_task_state']);
      return tools.filter(t => allowed.has(t.name));
    }
    if (contractKind === 'validate') {
      const allowed = new Set(['run_command', 'get_diagnostics', 'git_diff', 'git_status', 'update_task_state']);
      return tools.filter(t => allowed.has(t.name));
    }
    return tools;
  }

  /**
   * Build a compact step contract that proactively directs model behaviour.
   * Guards should become exceptional by making the intended step explicit.
   */
  private computeStepContract(
    state: ExecutionStateData
  ): { kind: 'discover' | 'mutate' | 'validate'; instruction: string; summary: string } {
    const planned = state.plannedFileBatch ?? [];
    const completed = state.completedBatchFiles ?? [];
    const remaining = planned.filter(f => !completed.includes(f));
    const phase = state.executionPhase ?? 'INITIALISING';

    if (phase === 'VALIDATING_STEP') {
      return {
        kind: 'validate',
        summary: 'validate recent mutations and capture results',
        instruction: 'STEP CONTRACT (VALIDATE): Run validation/diagnostics now. Allowed tools: run_command, get_diagnostics, git_diff/git_status, update_task_state. Do not read/search unless strictly required by a failing test trace.'
      };
    }

    // If inputs are resolved and at least one read has happened, transition to mutate.
    const hasResolvedInputs = (state.resolvedInputs ?? []).length > 0;
    const hasCompletedReads = (state.iterationsUsed ?? 0) >= 1 && hasResolvedInputs;

    if (phase === 'WRITE_ONLY' || remaining.length > 0 || (state.blockedReadCount ?? 0) >= 1 || hasCompletedReads) {
      const nextFile = remaining[0];
      return {
        kind: 'mutate',
        summary: nextFile
          ? `mutate next scheduled file (${nextFile})`
          : 'mutate now (write/edit) with no additional discovery',
        instruction: nextFile
          ? `STEP CONTRACT (MUTATE): Write or edit ${nextFile} now. Allowed tools: write_file, edit_file, replace_range, multi_edit, run_command, update_task_state. Do NOT call read/list/search tools in this step.`
          : 'STEP CONTRACT (MUTATE): Perform a file mutation now. Allowed tools: write_file, edit_file, replace_range, multi_edit, run_command, update_task_state. Do NOT call read/list/search tools in this step.'
      };
    }

    return {
      kind: 'discover',
      summary: 'perform minimal targeted discovery before next mutation',
      instruction: 'STEP CONTRACT (DISCOVER): Use minimal targeted discovery (prefer read_file_range/read_symbol_block over broad list/search). After enough evidence, switch to a write/edit in the next step.'
    };
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
