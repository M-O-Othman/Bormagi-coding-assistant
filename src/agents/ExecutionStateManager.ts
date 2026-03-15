import * as fs from 'fs/promises';
import * as path from 'path';
import type { ExecutionSubPhase } from './execution/ExecutionPhase';
import type { TaskTemplateName } from './execution/TaskTemplate';

/**
 * Structured pointer to the next tool call to execute on resume.
 * Allows the engine to dispatch directly without an LLM interpretation call.
 */
export interface NextToolCall {
  tool: string;
  input: Record<string, unknown>;
  description?: string;
}

/**
 * Terminal / milestone phase for the current run.
 * RUNNING = actively executing; all others terminate the run loop.
 */
export type SessionPhase =
  | 'RUNNING'
  | 'WAITING_FOR_USER_INPUT'
  | 'BLOCKED_BY_VALIDATION'
  | 'COMPLETED'
  | 'PARTIAL_BATCH_COMPLETE'
  | 'RECOVERY_REQUIRED';

/**
 * A single tool execution record — only real tool dispatches are recorded here,
 * never speculative assistant text.
 */
export interface ExecutedToolEntry {
  name: string;
  timestamp: string;
  inputPath?: string;
  outputSummary?: string;
}

/**
 * Structured summary of a resolved (read) input file.
 * Richer than a plain path — tracks content hash and summary for reuse.
 */
export interface ResolvedInputSummary {
  path: string;
  hash: string;
  summary: string;
  kind: 'requirements' | 'plan' | 'source' | 'config' | 'other';
  lastReadAt: string;
}

/**
 * Compact context packet — the minimal information needed to reconstruct
 * a code-mode prompt without replaying raw transcript history.
 */
export interface ContextPacket {
  objective: string;
  mode: string;
  workspaceType: 'greenfield' | 'scaffolded' | 'mature';
  phase: SessionPhase;
  nextAction?: string;
  nextToolCall?: NextToolCall;
  approvedPlanPath?: string;
  resolvedInputs: ResolvedInputSummary[];
  recentArtifacts: string[];
  blockers: string[];
  compactMilestone?: string;
}

/**
 * Compact cross-session task state — persisted to .bormagi/exec-state-<agentId>.json.
 *
 * Version 1: original shape (read-only tracking via buildContextNote prompt injection).
 * Version 2: adds authoritative mutation methods and additional runtime fields.
 *            All v2 fields are optional so v1 data migrates cleanly.
 */
export interface ExecutionStateData {
  version: 1 | 2;
  agentId: string;
  /** Original user objective (capped at 500 chars). */
  objective: string;
  /** Last active mode (plan / code / review / …). */
  mode: string;
  workspaceRoot: string;
  /** Paths of files read during this task — used to enforce the no-re-read rule. */
  resolvedInputs: string[];
  /** Paths of files successfully written — used to prevent duplicate creation. */
  artifactsCreated: string[];
  /** Natural-language descriptions of completed steps. */
  completedSteps: string[];
  /**
   * Next pending actions the agent should take on resume.
   * Set by the agent via update_task_state; consumed on continue.
   */
  nextActions: string[];
  /** Unresolved blockers or errors from the last session. */
  blockers: string[];
  /**
   * Framework choices committed to for this task.
   * E.g. { backend: "express", orm: "prisma", frontend: "react-vite" }
   */
  techStack: Record<string, string>;
  /** Cumulative tool iterations used across all sessions for this task. */
  iterationsUsed: number;
  /**
   * Files declared via `declare_file_batch` at the start of the current session.
   */
  plannedFileBatch: string[];
  updatedAt: string;

  // ── V2 fields (optional for backward compat) ──────────────────────────────

  /** Chronological log of all tools actually executed (not predicted). V2 only. */
  executedTools?: ExecutedToolEntry[];
  /** Name of the last successfully executed tool. V2 only. */
  lastExecutedTool?: string;
  /**
   * Terminal/milestone state for the current run.
   * 'RUNNING' means actively executing; all others terminate the run loop.
   * V2 only. Default: 'RUNNING'.
   */
  runPhase?: SessionPhase;
  /** Human-readable reason stored when runPhase is WAITING_FOR_USER_INPUT. V2 only. */
  waitStateReason?: string;
  /** Subset of plannedFileBatch that have been successfully written. V2 only. */
  completedBatchFiles?: string[];
  /**
   * Structured pointer to the next tool call to execute on resume.
   * Set alongside nextActions for direct dispatch without an extra LLM call. V2 only.
   */
  nextToolCall?: NextToolCall;
  /** Number of times a read was blocked this run (for recovery trigger). V2 only. */
  blockedReadCount?: number;
  /** Number of times user typed "continue" this run (for recovery trigger). V2 only. */
  continueCount?: number;
  /** Value of iterationsUsed at the time of the last continue (for progress check). V2 only. */
  continueIterationSnapshot?: number;
  /**
   * Transient in-run sub-state for observability.
   * Describes what the agent is doing within a single run iteration.
   * Set in memory only — not persisted across restarts (reset to INITIALISING on load).
   * V2 only.
   */
  executionPhase?: ExecutionSubPhase;
  /**
   * Task shape template classified at run start.
   * Drives stop rules, batch requirements, and skill loading. V2 only.
   */
  taskTemplate?: TaskTemplateName;

  // ── V2 enhanced fields (DD1 — context-awareness) ──────────────────────────

  /** Compact context packet rebuilt each turn. V2 only. */
  contextPacket?: ContextPacket;
  /** Path to the approved plan file. Once set, code mode defaults to implementation. V2 only. */
  approvedPlanPath?: string;
  /** Lifecycle status of known artifacts (plans, specs, source files). V2 only. */
  artifactStatus?: Record<string, 'drafted' | 'approved' | 'implemented' | 'superseded'>;
  /** ISO timestamp of last meaningful progress (write/edit). V2 only. */
  lastProgressAt?: string;
  /** Tracks same-tool same-path repetition for loop breaking. V2 only. */
  sameToolLoop?: { tool: string; path?: string; count: number };
  /** Richer resolved input summaries with hash-based reuse. V2 only. */
  resolvedInputSummaries?: ResolvedInputSummary[];
}

export class ExecutionStateManager {
  constructor(private readonly workspaceRoot: string) {}

  private stateDir(): string {
    return path.join(this.workspaceRoot, '.bormagi');
  }

  statePath(agentId: string): string {
    return path.join(this.stateDir(), `exec-state-${agentId}.json`);
  }

  /**
   * Load state from disk. Migrates v1 → v2 automatically.
   * Returns null if file is missing or corrupt.
   */
  async load(agentId: string): Promise<ExecutionStateData | null> {
    try {
      const raw = await fs.readFile(this.statePath(agentId), 'utf8');
      const data = JSON.parse(raw) as ExecutionStateData;
      if ((data.version !== 1 && data.version !== 2) || !data.agentId) { return null; }
      return this._migrate(data);
    } catch {
      return null;
    }
  }

  /**
   * Persist state atomically: write to a .tmp file then rename to the real path.
   * Prevents corrupt state files if the process crashes mid-write.
   */
  async save(agentId: string, state: ExecutionStateData): Promise<void> {
    const dir = this.stateDir();
    await fs.mkdir(dir, { recursive: true });
    const target = this.statePath(agentId);
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  /** Create a fresh v2 state for the first session of a task. */
  createFresh(agentId: string, objective: string, mode: string): ExecutionStateData {
    return {
      version: 2,
      agentId,
      objective,
      mode,
      workspaceRoot: this.workspaceRoot,
      resolvedInputs: [],
      artifactsCreated: [],
      completedSteps: [],
      nextActions: [],
      blockers: [],
      techStack: {},
      iterationsUsed: 0,
      plannedFileBatch: [],
      updatedAt: new Date().toISOString(),
      // v2 fields
      executedTools: [],
      lastExecutedTool: undefined,
      runPhase: 'RUNNING',
      waitStateReason: undefined,
      completedBatchFiles: [],
      nextToolCall: undefined,
      blockedReadCount: 0,
      continueCount: 0,
      continueIterationSnapshot: 0,
      // v2 enhanced fields (DD1)
      contextPacket: undefined,
      approvedPlanPath: undefined,
      artifactStatus: {},
      lastProgressAt: undefined,
      sameToolLoop: undefined,
      resolvedInputSummaries: [],
    };
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────

  private static readonly CONTINUE_PATTERN = /^\s*(continu[ei]|proceed|keep going|go on|go ahead|resume)\s*[.!]?\s*$/i;

  /**
   * Reconcile persisted execution state with an incoming user message.
   *
   * - If the message is a "continue" variant: only update objective text.
   * - Otherwise (new task): reset objective, mode, runtime counters, executed
   *   tools, blockedReadCount, continueCount, nextActions, nextToolCall, and
   *   taskTemplate.  resolvedInputs and artifactsCreated are kept so the
   *   reread / duplicate-write guards still function.
   *
   * The explicit `mode` parameter ALWAYS wins — stored mode is never carried
   * over (Tasks 3 + 4).
   */
  reconcileWithUserMessage(
    state: ExecutionStateData,
    userMessage: string,
    mode: string,
  ): void {
    const isContinue = ExecutionStateManager.CONTINUE_PATTERN.test(userMessage);

    // Mode parameter always wins — never let stored mode survive into a
    // different-mode session (Task 4).
    state.mode = mode;

    if (isContinue) {
      // Continuation: only refresh objective text (trim to 500 chars).
      state.objective = userMessage.slice(0, 500);
    } else {
      // New task: reset everything that is task-scoped.
      state.objective = userMessage.slice(0, 500);
      state.runPhase = 'RUNNING';
      state.waitStateReason = undefined;
      state.iterationsUsed = 0;
      state.blockedReadCount = 0;
      state.continueCount = 0;
      state.executedTools = [];
      state.nextActions = [];
      state.nextToolCall = undefined;
      state.taskTemplate = undefined;
      state.sameToolLoop = undefined;
      // Keep resolvedInputs + artifactsCreated so reread/dupe guards work.
    }

    state.updatedAt = new Date().toISOString();
  }

  // ── Mutation helpers (V2) ─────────────────────────────────────────────────
  // These update the in-memory state object. The caller is responsible for
  // calling save() at appropriate checkpoints.

  /**
   * Record a successfully-dispatched tool execution.
   * Increments iterationsUsed. Only call after confirmed dispatch success.
   */
  markToolExecuted(
    state: ExecutionStateData,
    toolName: string,
    inputPath?: string,
    outputSummary?: string
  ): void {
    state.executedTools ??= [];
    state.executedTools.push({
      name: toolName,
      timestamp: new Date().toISOString(),
      inputPath,
      outputSummary: outputSummary?.slice(0, 200),
    });
    state.lastExecutedTool = toolName;
    state.iterationsUsed += 1;
    state.updatedAt = new Date().toISOString();
  }

  /**
   * Record a file that was read. Idempotent — won't add duplicates.
   */
  markFileRead(state: ExecutionStateData, filePath: string): void {
    if (!state.resolvedInputs.includes(filePath)) {
      state.resolvedInputs.push(filePath);
      state.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Record a file that was successfully written.
   * Updates both artifactsCreated and completedBatchFiles.
   */
  markFileWritten(state: ExecutionStateData, filePath: string): void {
    if (!state.artifactsCreated.includes(filePath)) {
      state.artifactsCreated.push(filePath);
      state.updatedAt = new Date().toISOString();
    }
    // Also mark as completed in the batch if it was declared
    this.completeBatchFile(state, filePath);
  }

  /**
   * Set the primary next action for resume.
   * Replaces the first element; preserves any additional actions.
   */
  setNextAction(state: ExecutionStateData, action: string): void {
    if (action) {
      state.nextActions = [action, ...state.nextActions.slice(1)];
      state.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Mark a batch file as completed after a successful write.
   */
  completeBatchFile(state: ExecutionStateData, filePath: string): void {
    state.completedBatchFiles ??= [];
    if (!state.completedBatchFiles.includes(filePath)) {
      state.completedBatchFiles.push(filePath);
      state.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Returns true if the file has NOT been read this session (safe to read).
   * Returns false if already read and not subsequently written (re-read blocked).
   */
  canReadFile(state: ExecutionStateData, filePath: string): boolean {
    if (!state.resolvedInputs.includes(filePath)) { return true; }
    // Allow re-read only if the file was written after being read
    return state.artifactsCreated.includes(filePath);
  }

  /**
   * Set the structured next tool call for direct dispatch on resume.
   * Call after setting nextActions[0] to keep both fields in sync.
   */
  setNextToolCall(
    state: ExecutionStateData,
    tool: string,
    input: Record<string, unknown>,
    description?: string
  ): void {
    state.nextToolCall = { tool, input, description };
    state.updatedAt = new Date().toISOString();
  }

  /**
   * Set the transient in-run sub-phase (V2 only).
   * Not persisted — reset to INITIALISING when state is loaded.
   */
  setExecutionPhase(state: ExecutionStateData, phase: ExecutionSubPhase): void {
    state.executionPhase = phase;
  }

  /** Get the current in-run sub-phase, defaulting to INITIALISING if not set. */
  getExecutionPhase(state: ExecutionStateData): ExecutionSubPhase {
    return state.executionPhase ?? 'INITIALISING';
  }

  /** Clear the structured next tool call (called after it is dispatched on resume). */
  clearNextToolCall(state: ExecutionStateData): void {
    state.nextToolCall = undefined;
    state.updatedAt = new Date().toISOString();
  }

  /**
   * Set the terminal/milestone phase for the current run.
   * Once set to anything other than 'RUNNING', the AgentRunner loop will exit.
   */
  setRunPhase(state: ExecutionStateData, phase: SessionPhase, reason?: string): void {
    state.runPhase = phase;
    if (reason !== undefined) { state.waitStateReason = reason; }
    state.updatedAt = new Date().toISOString();
  }

  /**
   * Build a compact one-block summary string for use in PromptAssembler.
   * Targets ~300 chars for typical tasks to minimise token overhead.
   */
  buildCompactSummary(state: ExecutionStateData): string {
    const lines: string[] = [
      `Objective: ${state.objective.slice(0, 200)}`,
      `Mode: ${state.mode} | Iterations: ${state.iterationsUsed}`,
    ];

    if (state.techStack && Object.keys(state.techStack).length > 0) {
      lines.push(`Tech stack: ${JSON.stringify(state.techStack)}`);
    }

    if (state.artifactsCreated.length > 0) {
      const files = state.artifactsCreated.slice(-5);
      lines.push(`Files written: ${files.join(', ')}${state.artifactsCreated.length > 5 ? ` (+${state.artifactsCreated.length - 5} more)` : ''}`);
    }

    if (state.nextActions.length > 0) {
      lines.push(`Next: ${state.nextActions[0]}`);
      if (state.nextToolCall) {
        lines.push(`Next tool: ${state.nextToolCall.tool}(${JSON.stringify(state.nextToolCall.input).slice(0, 80)})`);
      }
    }

    const planned = state.plannedFileBatch ?? [];
    if (planned.length > 0) {
      const completed = state.completedBatchFiles ?? [];
      const remaining = planned.filter(f => !completed.includes(f));
      if (remaining.length > 0) {
        lines.push(`Batch remaining: ${remaining.slice(0, 3).join(', ')}${remaining.length > 3 ? ` +${remaining.length - 3} more` : ''}`);
      }
    }

    return lines.join('\n');
  }

  // ── Next-step synthesis (Task 5) ─────────────────────────────────────────

  /**
   * Deterministic next-step computation after each successful tool call.
   * Returns an action hint (and optionally a structured NextToolCall) so the
   * agent does not need to re-derive what to do next from scratch.
   *
   * Returns null when there is no deterministic recommendation — the LLM
   * should decide on its own.
   */
  computeNextStep(
    state: ExecutionStateData,
    lastToolName: string,
    lastToolPath: string | undefined,
    lastToolResult: string,
    workspaceType: 'greenfield' | 'scaffolded' | 'mature',
  ): { nextAction: string; nextToolCall?: NextToolCall } | null {
    const planned = state.plannedFileBatch ?? [];
    const completed = state.completedBatchFiles ?? [];
    const remaining = planned.filter(f => !completed.includes(f));

    // After reading a plan file in any mode → concrete write action
    if (lastToolName === 'read_file' && lastToolPath) {
      const lower = lastToolPath.toLowerCase();

      // After reading a spec/requirements/plan file → write first implementation file
      if (lower.includes('spec') || lower.includes('requirement') || lower.includes('plan')) {
        if (workspaceType === 'greenfield' || workspaceType === 'scaffolded') {
          return {
            nextAction: 'Call declare_file_batch with the project file list, then write the first file',
          };
        }
        return {
          nextAction: 'Write the first implementation file now based on the plan you just read',
        };
      }

      // After reading any other file → write or edit
      return {
        nextAction: 'Write or edit the next file based on what you just read — do not read more files',
      };
    }

    // After list_files in greenfield → declare batch
    if (lastToolName === 'list_files' && (workspaceType === 'greenfield' || workspaceType === 'scaffolded')) {
      return {
        nextAction: 'Call declare_file_batch with the project file list, then write the first implementation file',
      };
    }

    // After list_files in mature → read or write
    if (lastToolName === 'list_files') {
      return {
        nextAction: 'Read the most relevant file or start writing — do not list files again',
      };
    }

    // After write_file with batch remaining → write the next batch file
    if (lastToolName === 'write_file' && remaining.length > 0) {
      const nextFile = remaining[0];
      return {
        nextAction: `Write the next file in the batch: ${nextFile}`,
        nextToolCall: { tool: 'write_file', input: { path: nextFile }, description: `Write batch file: ${nextFile}` },
      };
    }

    // After write_file without batch in greenfield → declare batch if not done
    if (lastToolName === 'write_file' && workspaceType === 'greenfield' && planned.length === 0) {
      return {
        nextAction: 'declare_file_batch if not done, then continue writing',
      };
    }

    // After edit_file → verify the edit, then continue
    if (lastToolName === 'edit_file') {
      return {
        nextAction: 'Verify the edit, then continue to next task',
      };
    }

    // Fallback: let the LLM decide
    return null;
  }

  // ── DD5: Deterministic next-step synthesis ─────────────────────────────────

  /**
   * Compute a deterministic, write-oriented next step based on structured state.
   * Unlike computeNextStep() which is advisory, this method produces concrete
   * tool calls that the controller can dispatch directly without an LLM round.
   *
   * Returns null when no deterministic recommendation is possible.
   */
  computeDeterministicNextStep(
    state: ExecutionStateData,
    workspaceType: 'greenfield' | 'scaffolded' | 'mature',
  ): { nextAction: string; nextToolCall?: NextToolCall } | null {
    const planned = state.plannedFileBatch ?? [];
    const completed = state.completedBatchFiles ?? [];
    const remaining = planned.filter(f => !completed.includes(f));

    // 1. Approved plan exists + greenfield + no batch → advise LLM to declare batch
    //    declare_file_batch is a virtual tool requiring LLM-supplied file list — cannot be direct-dispatched.
    if (state.approvedPlanPath && state.artifactStatus?.[state.approvedPlanPath] === 'approved') {
      if ((workspaceType === 'greenfield' || workspaceType === 'scaffolded') && planned.length === 0) {
        return {
          nextAction: 'Call declare_file_batch with the project file list from the approved plan, then write the first scaffold file',
        };
      }
    }

    // 2. Batch exists + first file not yet written → write it
    if (remaining.length > 0) {
      const nextFile = remaining[0];
      return {
        nextAction: `Write the next batch file: ${nextFile}`,
        nextToolCall: { tool: 'write_file', input: { path: nextFile }, description: `Write batch file: ${nextFile}` },
      };
    }

    // 3. Repeated blocked reads → force a write step
    if ((state.blockedReadCount ?? 0) >= 2) {
      if (workspaceType === 'greenfield' && planned.length === 0 && state.artifactsCreated.length === 0) {
        return {
          nextAction: 'Stop reading. Call declare_file_batch with the project file list, then write the first file',
        };
      }
      if (state.artifactsCreated.length > 0) {
        return {
          nextAction: `Continue implementation — write or edit the next file`,
        };
      }
    }

    // 4. Greenfield with no batch and no artifacts → scaffold
    if (workspaceType === 'greenfield' && planned.length === 0 && state.artifactsCreated.length === 0) {
      return {
        nextAction: 'Call declare_file_batch with the project file list, then write the first implementation file',
      };
    }

    return null;
  }

  // ── DD1: Context packet and resolved input management ────────────────────

  /**
   * Set the approved plan path and update artifact status.
   * Once set, code-mode turns default to implementation.
   */
  markPlanApproved(state: ExecutionStateData, planPath: string): void {
    state.approvedPlanPath = planPath;
    state.artifactStatus ??= {};
    state.artifactStatus[planPath] = 'approved';
    state.nextActions = ['Declare implementation batch and write first scaffold file'];
    state.updatedAt = new Date().toISOString();
  }

  /** Set artifact lifecycle status for a given path. */
  setArtifactStatus(state: ExecutionStateData, artifactPath: string, status: 'drafted' | 'approved' | 'implemented' | 'superseded'): void {
    state.artifactStatus ??= {};
    state.artifactStatus[artifactPath] = status;
    state.updatedAt = new Date().toISOString();
  }

  /** Upsert a resolved input summary (hash-based reuse). */
  upsertResolvedInputSummary(state: ExecutionStateData, summary: ResolvedInputSummary): void {
    state.resolvedInputSummaries ??= [];
    const idx = state.resolvedInputSummaries.findIndex(s => s.path === summary.path);
    if (idx >= 0) {
      state.resolvedInputSummaries[idx] = summary;
    } else {
      state.resolvedInputSummaries.push(summary);
    }
    state.updatedAt = new Date().toISOString();
  }

  /** Rebuild the compact context packet from current state. */
  rebuildContextPacket(state: ExecutionStateData, workspaceType: 'greenfield' | 'scaffolded' | 'mature'): ContextPacket {
    const packet: ContextPacket = {
      objective: state.objective,
      mode: state.mode,
      workspaceType,
      phase: state.runPhase ?? 'RUNNING',
      nextAction: state.nextActions[0],
      nextToolCall: state.nextToolCall,
      approvedPlanPath: state.approvedPlanPath,
      resolvedInputs: state.resolvedInputSummaries ?? [],
      recentArtifacts: state.artifactsCreated.slice(-5),
      blockers: state.blockers,
      compactMilestone: state.lastExecutedTool
        ? `Last tool: ${state.lastExecutedTool}`
        : undefined,
    };
    state.contextPacket = packet;
    return packet;
  }

  // ── DD4: Blocked read and tool loop tracking ─────────────────────────────

  /** Increment blocked read counter and record the path. */
  incrementBlockedRead(state: ExecutionStateData, blockedPath: string): void {
    state.blockedReadCount = (state.blockedReadCount ?? 0) + 1;
    state.updatedAt = new Date().toISOString();
  }

  /** Record a tool+path repetition for same-tool loop detection. */
  recordToolLoop(state: ExecutionStateData, tool: string, toolPath?: string): void {
    const current = state.sameToolLoop;
    if (current && current.tool === tool && current.path === toolPath) {
      current.count += 1;
    } else {
      state.sameToolLoop = { tool, path: toolPath, count: 1 };
    }
    state.updatedAt = new Date().toISOString();
  }

  /** Reset the same-tool loop tracker (after a productive action). */
  resetToolLoop(state: ExecutionStateData): void {
    state.sameToolLoop = undefined;
    state.updatedAt = new Date().toISOString();
  }

  /** Record a write/edit as meaningful progress. */
  markProgress(state: ExecutionStateData): void {
    state.lastProgressAt = new Date().toISOString();
    state.updatedAt = state.lastProgressAt;
  }

  // ── Context note builder ──────────────────────────────────────────────────

  /**
   * Build a compact system-context note injected at the start of each session.
   * Kept under ~400 chars for common cases to minimise token overhead.
   */
  buildContextNote(state: ExecutionStateData): string {
    const lines: string[] = [
      '[Execution State — resume context]',
      `Objective: ${state.objective}`,
      `Mode: ${state.mode} | Iterations used so far: ${state.iterationsUsed}`,
    ];

    if (state.techStack && Object.keys(state.techStack).length > 0) {
      lines.push(
        `Architecture lock — committed tech stack: ${JSON.stringify(state.techStack)}. Do NOT use other frameworks.`
      );
    }

    if (state.artifactsCreated.length > 0) {
      lines.push(
        `Files already created (do not recreate, use edit_file):\n${state.artifactsCreated.map(f => `  - ${f}`).join('\n')}`
      );
    }

    if (state.completedSteps.length > 0) {
      const recent = state.completedSteps.slice(-5);
      lines.push(`Completed steps:\n${recent.map(s => `  ✓ ${s}`).join('\n')}`);
    }

    if (state.nextActions.length > 0) {
      lines.push(`Next pending actions:\n${state.nextActions.map(a => `  → ${a}`).join('\n')}`);
    }

    if (state.blockers.length > 0) {
      lines.push(`Blockers from last session:\n${state.blockers.map(b => `  ! ${b}`).join('\n')}`);
    }

    if (state.resolvedInputs.length > 0) {
      lines.push(`Files already read this task (skip re-reading unless you wrote to them): ${state.resolvedInputs.join(', ')}`);
    }

    const planned = state.plannedFileBatch ?? [];
    if (planned.length > 0) {
      const completed = state.completedBatchFiles ?? [];
      const remaining = planned.filter(f => !completed.includes(f));
      const batchSummary = remaining.length === 0
        ? `Declared batch: all ${planned.length} files written.`
        : `Declared batch: ${completed.length}/${planned.length} done. Remaining: ${remaining.slice(0, 4).join(', ')}${remaining.length > 4 ? ` +${remaining.length - 4} more` : ''}`;
      lines.push(batchSummary);
    }

    return lines.join('\n');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Upgrade v1 state to v2 by adding missing optional fields with defaults. */
  private _migrate(data: ExecutionStateData): ExecutionStateData {
    if (data.version === 1) {
      data.version = 2;
      data.executedTools ??= [];
      data.lastExecutedTool ??= undefined;
      data.completedBatchFiles ??= [...(data.artifactsCreated ?? [])];
    }
    // Ensure v2 terminal-phase fields exist (may be missing from older v2 saves)
    data.runPhase ??= 'RUNNING';
    data.blockedReadCount ??= 0;
    data.continueCount ??= 0;
    data.continueIterationSnapshot ??= 0;
    // DD1 enhanced fields
    data.artifactStatus ??= {};
    data.resolvedInputSummaries ??= [];
    return data;
  }
}
