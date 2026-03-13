import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Compact cross-session task state — persisted to .bormagi/exec-state-<agentId>.json.
 *
 * Replaces raw transcript replay: instead of injecting prior assistant narration as
 * history, we inject a compact JSON-derived note so the model knows what has been
 * done, what artifacts exist, and what to do next — without the noise.
 */
export interface ExecutionStateData {
  version: 1;
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
   * The agent is responsible for keeping this updated via structured output.
   */
  nextActions: string[];
  /** Unresolved blockers or errors from the last session. */
  blockers: string[];
  /**
   * Framework choices committed to for this task.
   * E.g. { backend: "express", orm: "prisma", frontend: "react-vite" }
   * Once set, these are injected as a hard constraint so the model cannot
   * switch frameworks mid-implementation.
   */
  techStack: Record<string, string>;
  /** Cumulative tool iterations used across all sessions for this task. */
  iterationsUsed: number;
  /**
   * Files declared via `declare_file_batch` at the start of the current session.
   * The framework tracks writes against this list and reports progress after each write.
   */
  plannedFileBatch: string[];
  updatedAt: string;
}

export class ExecutionStateManager {
  constructor(private readonly workspaceRoot: string) {}

  private stateDir(): string {
    return path.join(this.workspaceRoot, '.bormagi');
  }

  statePath(agentId: string): string {
    return path.join(this.stateDir(), `exec-state-${agentId}.json`);
  }

  async load(agentId: string): Promise<ExecutionStateData | null> {
    try {
      const raw = await fs.readFile(this.statePath(agentId), 'utf8');
      const data = JSON.parse(raw) as ExecutionStateData;
      // Reject stale or corrupt state (version mismatch)
      if (data.version !== 1 || !data.agentId) { return null; }
      return data;
    } catch {
      return null;
    }
  }

  async save(agentId: string, state: ExecutionStateData): Promise<void> {
    await fs.mkdir(this.stateDir(), { recursive: true });
    await fs.writeFile(this.statePath(agentId), JSON.stringify(state, null, 2), 'utf8');
  }

  /** Create a fresh state for the first session of a task. */
  createFresh(agentId: string, objective: string, mode: string): ExecutionStateData {
    return {
      version: 1,
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
    };
  }

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
      const recent = state.completedSteps.slice(-5); // last 5 steps only
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
      lines.push(`Declared file batch (${planned.length} files): ${planned.join(', ')}`);
    }

    return lines.join('\n');
  }
}
