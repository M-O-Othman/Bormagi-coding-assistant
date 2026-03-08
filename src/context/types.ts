// ─── Context Pipeline: Shared Type Definitions ────────────────────────────────
//
// All interfaces for the context and token management pipeline.
// Spec reference: 2.ai_coding_assistant_context_token_comprehensive_spec.v2.md

// ─── Mode ─────────────────────────────────────────────────────────────────────

export type AssistantMode =
  | "plan"
  | "edit"
  | "debug"
  | "review"
  | "explain"
  | "search"
  | "test-fix"
  | "ask"
  | "code";

export interface ModeDecision {
  mode: AssistantMode;
  confidence: number;
  secondaryIntents: string[];
  reason: string;
  /** True when the mode was explicitly chosen by the user, not auto-detected. */
  userOverride: boolean;
}

// ─── Budget & Thresholds ──────────────────────────────────────────────────────

export interface ModeBudget {
  stablePrefix: number;
  memory: number;
  repoMap: number;
  retrievedContext: number;
  toolOutputs: number;
  conversationTail: number;
  userInput: number;
  reservedMargin: number;
}

export interface BudgetCheckResult {
  fits: boolean;
  estimatedInputTokens: number;
  hardLimit: number;
  softLimit: number;
  overflowBy: number;
  /** Ordered list of remediation actions to apply. */
  actions: Array<
    | "prune-reference-snippets"
    | "reduce-repo-map"
    | "summarize-tool-outputs"
    | "reduce-conversation-tail"
    | "degrade-to-plan-only"
  >;
}

export interface ContextThresholds {
  warnAtPct: number;
  pruneAtPct: number;
  compactAtPct: number;
  emergencyAtPct: number;
}

// ─── Model / Provider Profile ─────────────────────────────────────────────────

export interface ModelProfile {
  provider: string;
  model: string;
  maxContextTokens: number;
  recommendedInputBudget: number;
  defaultMaxOutputTokens: number;
  supportsPromptCaching: boolean;
  supportsToolUse: boolean;
  estimatedToolOverheadTokens: number;
  thresholds: ContextThresholds;
}

/** Resolved policy for which agent handles context-pipeline operations. */
export interface ModeModelPolicy {
  /** ID of the system-reserved context agent (`__bormagi_context_agent__`). */
  contextAgentId: string;
  /** ID of the primary coding agent for code generation. */
  primaryExecutionAgentId?: string;
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

export interface RequestTelemetry {
  requestId: string;
  mode: AssistantMode;
  model: string;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  outputTokens?: number;
  cacheHitKeys: string[];
  candidateCount: number;
  includedCount: number;
  compactionTriggered: boolean;
  degradedMode: boolean;
  providerError?: string;
  latencyMs: number;
}

// ─── Repo Map ─────────────────────────────────────────────────────────────────

export interface SymbolEntry {
  name: string;
  kind: "class" | "function" | "method" | "interface" | "type" | "const" | "enum";
  signature?: string;
  summary?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface FileMapEntry {
  path: string;
  language: string;
  exports: string[];
  imports: string[];
  symbols: SymbolEntry[];
  summary?: string;
  lineCount: number;
  byteSize: number;
  lastModifiedUtc?: string;
  flags: {
    generated: boolean;
    test: boolean;
    config: boolean;
    vendored: boolean;
    binary: boolean;
  };
}

export interface RepoMap {
  repoRoot: string;
  generatedAtUtc: string;
  entries: FileMapEntry[];
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export interface RetrievalQuery {
  text: string;
  mode: AssistantMode;
  activeFile?: string;
  selectedSymbol?: string;
  stackTrace?: string;
  failingTestNames?: string[];
}

export interface ContextCandidate {
  id: string;
  kind: "file" | "snippet" | "symbol" | "tool-output" | "memory" | "repo-map";
  path?: string;
  symbol?: string;
  content: string;
  tokenEstimate: number;
  score: number;
  reasons: string[];
  editable: boolean;
}

export interface ContextEnvelope {
  editable: ContextCandidate[];
  reference: ContextCandidate[];
  memory: ContextCandidate[];
  toolOutputs: ContextCandidate[];
}

// ─── Compaction ───────────────────────────────────────────────────────────────

export interface ArchitectureDecision {
  id: string;
  title: string;
  decision: string;
  rationale?: string;
  implications?: string[];
  sourceTurnId?: string;
}

export interface CompactedHistory {
  currentObjective: string;
  decisions: string[];
  blockers: string[];
  recentActions: string[];
  recentArtifacts: string[];
  pendingNextSteps: string[];
  narrativeSummary?: string;
}

export interface CompactionInput {
  transcript: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  recentArtifacts: string[];
  activeMode: AssistantMode;
  currentGoal?: string;
}

export interface CompactionOutput {
  structured: CompactedHistory;
  narrative: string;
  droppedMessages: number;
}

// ─── Enhanced Session Memory ──────────────────────────────────────────────────

export interface EnhancedSessionMemoryState {
  projectSummary?: string;
  codingConventions: string[];
  decisions: ArchitectureDecision[];
  currentGoal?: string;
  currentPlan: string[];
  unresolvedQuestions: string[];
  recentEditedFiles: string[];
  recentFailures: string[];
  recentSuccesses: string[];
  updatedAtUtc: string;
}

// ─── Stable Prefix Cache ──────────────────────────────────────────────────────

export interface CachedPromptSegment {
  cacheKey: string;
  content: string;
  contentHash: string;
  createdAtUtc: string;
  componentType: "system" | "rules" | "repo-map" | "memory" | "tools";
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export type HookEvent =
  | "session-start"
  | "before-tool"
  | "after-tool"
  | "after-edit"
  | "before-final"
  | "after-compaction";

export interface HookConfig {
  event: HookEvent;
  /** "internal" = in-process Node.js handler; "shell" = child_process.exec command. */
  type: "internal" | "shell";
  /** Glob patterns for files this hook applies to (after-edit). */
  match?: string[];
  /** Tool name filter (before-tool / after-tool). */
  tool?: string;
  /** Handler identifier for internal hooks. */
  handler?: string;
  /** Shell command for shell hooks. Supports {{changedFiles}} template. */
  command?: string;
  description?: string;
}

export interface HookContext {
  event: HookEvent;
  mode: AssistantMode;
  changedFiles?: string[];
  toolName?: string;
  payload?: Record<string, unknown>;
}

export interface HookResult {
  allow: boolean;
  messages?: string[];
  contextToInject?: string[];
  commandsToRun?: string[];
}

// ─── Plan Artifacts ───────────────────────────────────────────────────────────

export interface PlanMilestone {
  id: string;
  title: string;
  tasks: string[];
  validations: string[];
  status: "todo" | "in-progress" | "blocked" | "done";
  notes?: string[];
}

export interface ExecutionPlan {
  id: string;
  objective: string;
  milestones: PlanMilestone[];
  decisions: string[];
  blockers: string[];
  createdAtUtc: string;
  updatedAtUtc: string;
}

// ─── Instruction Layers ───────────────────────────────────────────────────────

export interface InstructionLayer {
  /** "global" = .bormagi/instructions/global.md; "repo" = .bormagi/instructions/repo.md */
  role: "global" | "repo";
  filePath: string;
  content: string;
  tokenEstimate: number;
  /** True when the backing file does not exist on disk. */
  missing: boolean;
}

export interface EffectiveInstructions {
  layers: InstructionLayer[];
  /** Merged, token-bounded text of all layers. */
  merged: string;
  totalTokenEstimate: number;
}

// ─── Capability / Skill Loading ───────────────────────────────────────────────

export interface CapabilityManifest {
  id: string;
  name: string;
  description: string;
  applicableModes: AssistantMode[];
  requiredTools: string[];
  estimatedTokens: number;
  manifestPath: string;
}

export interface LoadedCapability extends CapabilityManifest {
  instructions: string;
  references?: string[];
  scripts?: string[];
}

// ─── Prompt Assembly ──────────────────────────────────────────────────────────

export interface PromptSections {
  system: string;
  rules: string;
  memory: string;
  repoMap: string;
  task: string;
  editableContext: string;
  referenceContext: string;
  toolArtifacts: string;
  conversationTail: string;
  outputContract: string;
}

// ─── Tool Artifact Normalization ──────────────────────────────────────────────

export interface TestFailureArtifact {
  /** Individual test failures extracted from the runner output. */
  failures: Array<{ testName: string; message: string }>;
  /** Source files referenced in failing tests or stack traces. */
  failingFiles: string[];
  /** Bounded raw output excerpt for full context. */
  rawExcerpt: string;
  /** Condensed stack trace (first 10 frames). */
  stackTrace: string;
  tokenEstimate: number;
}

export interface SearchHitArtifact {
  filePath: string;
  line: number;
  snippet: string;
  tokenEstimate: number;
}

// ─── Checkpoint ───────────────────────────────────────────────────────────────

export interface CheckpointState {
  sessionId: string;
  activeMode: AssistantMode;
  compactedSummary?: CompactedHistory;
  currentPlan: string[];
  recentEditedFiles: string[];
  lastValidatedStateUtc?: string;
  pendingToolArtifacts: string[];
  savedAtUtc: string;
}
