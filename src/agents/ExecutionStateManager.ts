import * as fs from 'fs/promises';
import * as path from 'path';

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
    };
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
    return data;
  }
}
