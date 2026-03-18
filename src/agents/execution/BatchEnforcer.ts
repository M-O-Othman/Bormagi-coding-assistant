import * as fs from 'fs/promises';
import * as path from 'path';
import type { ExecutionStateData } from '../ExecutionStateManager';

export type WorkspaceType = 'greenfield' | 'docs_only' | 'scaffolded' | 'mature';

export interface BatchProgress {
  total: number;
  completed: number;
  remaining: string[];
}

/**
 * Enforces declared file batches and determines workspace maturity type.
 *
 * Batch enforcement is driven by the active TaskTemplate's `requiresBatch` flag,
 * NOT by workspace type. Workspace type influences template *selection* (in
 * TaskClassifier) but has no role in runtime enforcement.
 *
 * Wired into AgentRunner's tool_use handler (Phase 4, executionEngineV2 flag).
 */
export class BatchEnforcer {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Classify the workspace as greenfield, docs_only, scaffolded, or mature.
   *
   * greenfield  — truly empty: no files at all (ignoring .bormagi/ and .gitignore)
   * docs_only   — has documentation files (.md, .txt, .rst) or .bormagi/ but no source code or project manifests
   * scaffolded  — project manifest exists but fewer than 5 source files total
   * mature      — project manifest with 5+ source files, or any recognised project structure
   */
  async detectWorkspaceType(): Promise<WorkspaceType> {
    const hasPkgJson = await this._exists('package.json');
    const hasSrcDir = await this._exists('src');
    const hasBackend = await this._exists('backend');
    const hasFrontend = await this._exists('frontend');
    const hasApp = await this._exists('app');
    // Also check for Python/Go/Rust project manifests
    const hasPyProject = await this._exists('pyproject.toml');
    const hasRequirementsTxt = await this._exists('requirements.txt');
    const hasGoMod = await this._exists('go.mod');
    const hasCargoToml = await this._exists('Cargo.toml');
    const hasAnyManifest = hasPkgJson || hasPyProject || hasRequirementsTxt || hasGoMod || hasCargoToml;

    // No project structure at all → check if docs_only or truly greenfield
    if (!hasAnyManifest && !hasSrcDir && !hasBackend && !hasFrontend && !hasApp) {
      // Check if the workspace has any non-.bormagi, non-.git files
      const hasDocFiles = await this._hasDocFiles();
      if (hasDocFiles) {
        return 'docs_only';
      }
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
   * Check whether a write to `filePath` is permitted given the current execution state.
   *
   * Enforcement is driven entirely by `templateRequiresBatch` (from the active
   * TaskTemplate). Workspace type is NOT consulted — it already influenced
   * template selection via TaskClassifier. This prevents contradictions between
   * the template's intent and the workspace's physical state.
   *
   * Logic:
   *   - Template says requiresBatch=false → always allow (no batch needed)
   *   - Template says requiresBatch=true, no batch declared → block
   *   - Template says requiresBatch=true, batch declared, file in batch → allow
   *   - Template says requiresBatch=true, batch declared, file NOT in batch → block
   *
   * Returns null if permitted, or a rejection string if blocked.
   */
  checkWritePermission(
    filePath: string,
    execState: ExecutionStateData,
    blockedMessage: string,
    templateRequiresBatch: boolean
  ): string | null {
    // Template says batch is not required — always allow
    if (!templateRequiresBatch) {
      return null;
    }

    // Template requires batch — check if one has been declared
    const batch = execState.plannedFileBatch ?? [];
    if (batch.length === 0) {
      return blockedMessage;
    }

    // Batch declared — check if this file is in it (normalise both sides)
    const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
    const normalised = normalise(filePath);
    const inBatch = batch.some(p => normalise(p) === normalised);
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

  /** Check if workspace has doc/config files (not just .bormagi and .git). */
  private async _hasDocFiles(): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.workspaceRoot);
      const IGNORED = new Set(['.bormagi', '.git', '.gitignore', 'node_modules']);
      return entries.some(e => !IGNORED.has(e));
    } catch {
      return false;
    }
  }

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
