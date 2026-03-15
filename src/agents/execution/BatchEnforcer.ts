import * as fs from 'fs/promises';
import * as path from 'path';
import type { ExecutionStateData } from '../ExecutionStateManager';

export type WorkspaceType = 'greenfield' | 'scaffolded' | 'mature';

export interface BatchProgress {
  total: number;
  completed: number;
  remaining: string[];
}

/**
 * Enforces declared file batches and determines workspace maturity type.
 *
 * Greenfield/scaffolded workspaces must declare a batch before the first write_file.
 * Mature workspaces (existing projects) may write without a batch declaration.
 *
 * Wired into AgentRunner's tool_use handler (Phase 4, executionEngineV2 flag).
 */
export class BatchEnforcer {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Classify the workspace as greenfield, scaffolded, or mature.
   *
   * greenfield  — no package.json AND no src/ directory
   * scaffolded  — package.json exists but fewer than 5 source files total
   * mature      — package.json with 5+ source files, or any recognised project structure
   */
  async detectWorkspaceType(): Promise<WorkspaceType> {
    const hasPkgJson = await this._exists('package.json');
    const hasSrcDir = await this._exists('src');
    const hasBackend = await this._exists('backend');
    const hasFrontend = await this._exists('frontend');
    const hasApp = await this._exists('app');

    // No project structure at all → greenfield
    if (!hasPkgJson && !hasSrcDir && !hasBackend && !hasFrontend && !hasApp) {
      return 'greenfield';
    }

    // Has project dirs but few source files → scaffolded
    if (hasPkgJson) {
      const sourceCount = await this._countSourceFiles();
      if (sourceCount < 5) {
        return 'scaffolded';
      }
    }

    // Has project dirs without package.json → scaffolded
    if (!hasPkgJson && (hasBackend || hasFrontend || hasApp)) {
      return 'scaffolded';
    }

    return 'mature';
  }

  /**
   * Returns true when a batch must be declared before the first write_file.
   * Mandatory for greenfield and scaffolded workspaces (not mature ones).
   */
  async isBatchMandatory(): Promise<boolean> {
    const type = await this.detectWorkspaceType();
    return type === 'greenfield' || type === 'scaffolded';
  }

  /**
   * Check whether a write to `filePath` is permitted given the current execution state.
   *
   * Returns null if permitted, or a rejection string if blocked.
   */
  checkWritePermission(
    filePath: string,
    execState: ExecutionStateData,
    blockedMessage: string,
    workspaceType: WorkspaceType
  ): string | null {
    const batch = execState.plannedFileBatch ?? [];

    // Mature workspaces: batch is advisory, never blocking
    if (workspaceType === 'mature') {
      return null;
    }

    // No batch declared yet
    if (batch.length === 0) {
      // If batch is mandatory (greenfield/scaffolded), reject the write
      if (workspaceType === 'greenfield' || workspaceType === 'scaffolded') {
        return blockedMessage;
      }
      return null;
    }

    // Batch declared — check if this file is in it
    const normalised = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const inBatch = batch.some(p => p.replace(/\\/g, '/') === normalised);
    if (!inBatch) {
      return blockedMessage;
    }

    return null;
  }

  /** Summarise batch progress from execution state. */
  getBatchProgress(execState: ExecutionStateData): BatchProgress {
    const batch = execState.plannedFileBatch ?? [];
    const completed = execState.completedBatchFiles ?? [];
    const remaining = batch.filter(p => !completed.includes(p));
    return { total: batch.length, completed: completed.length, remaining };
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private async _exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.workspaceRoot, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  private async _countSourceFiles(): Promise<number> {
    const srcExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs']);
    let count = 0;
    try {
      await this._walk(this.workspaceRoot, srcExtensions, (n) => { count += n; }, 3);
    } catch {
      // ignore — return best-effort count
    }
    return count;
  }

  private async _walk(
    dir: string,
    extensions: Set<string>,
    onCount: (n: number) => void,
    maxDepth: number
  ): Promise<void> {
    if (maxDepth <= 0) { return; }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._walk(fullPath, extensions, onCount, maxDepth - 1);
      } else if (extensions.has(path.extname(entry.name))) {
        onCount(1);
      }
    }
  }
}
