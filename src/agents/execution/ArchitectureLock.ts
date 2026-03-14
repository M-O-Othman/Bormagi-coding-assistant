import * as fs from 'fs/promises';
import * as path from 'path';

export interface ArchitectureLockData {
  backend?: string;
  orm?: string;
  frontend?: string;
  language?: string;
  testFramework?: string;
  /** Confidence in the auto-detected lock — high when multiple signals agree. */
  confidence: 'high' | 'low';
}

export interface ArchitectureConflict {
  detected: string;
  locked: string;
  category: string;
}

/**
 * Auto-detects the committed tech stack from workspace config files and
 * enforces it across sessions to prevent mid-task framework switching.
 *
 * Detection sources (in priority order):
 *   1. execState.techStack (user-supplied via update_task_state)
 *   2. package.json dependencies
 *   3. Config files (requirements.txt, go.mod, Cargo.toml, etc.)
 */
export class ArchitectureLock {
  private _patterns: Record<string, Record<string, unknown>> = {};

  constructor(
    private readonly workspaceRoot: string,
    patterns: Record<string, unknown>
  ) {
    this._patterns = patterns as Record<string, Record<string, unknown>>;
  }

  /**
   * Scan the workspace and produce an architecture lock.
   * Returns null if no meaningful signals are found.
   */
  async detect(): Promise<ArchitectureLockData | null> {
    const lock: Partial<ArchitectureLockData> = {};
    let signalCount = 0;

    // ── package.json dependencies ──────────────────────────────────────────
    try {
      const raw = await fs.readFile(path.join(this.workspaceRoot, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...pkg.dependencies ?? {},
        ...pkg.devDependencies ?? {},
      };

      for (const [depName] of Object.entries(allDeps)) {
        for (const [category, depMap] of Object.entries(this._patterns)) {
          if (category === 'configFiles' || category === 'conflictImportPrefixes') { continue; }
          const framework = (depMap as Record<string, unknown>)[depName] as string | undefined;
          if (framework && !(lock as Record<string, unknown>)[category]) {
            (lock as Record<string, unknown>)[category] = framework;
            signalCount++;
          }
        }
      }
    } catch {
      // no package.json — try config files
    }

    // ── config files → language detection ─────────────────────────────────
    const configFileMap = this._patterns.configFiles as Record<string, unknown> | undefined;
    if (configFileMap) {
      for (const [filename, language] of Object.entries(configFileMap as Record<string, string>)) {
        try {
          await fs.access(path.join(this.workspaceRoot, filename));
          if (!lock.language) {
            lock.language = language;
            signalCount++;
          }
          break;
        } catch {
          // file not present
        }
      }
    }

    if (signalCount === 0) { return null; }

    lock.confidence = signalCount >= 2 ? 'high' : 'low';
    return lock as ArchitectureLockData;
  }

  /**
   * Check whether `content` (file content being written) conflicts with `lock`.
   * Returns a list of conflicts found, or empty array if none.
   */
  checkConflicts(
    content: string,
    lock: ArchitectureLockData,
    userTechStack: Record<string, string>
  ): ArchitectureConflict[] {
    const conflicts: ArchitectureConflict[] = [];
    const mergedLock = { ...lock, ...userTechStack };
    const conflictMap = (this._patterns.conflictImportPrefixes ?? undefined) as Record<string, string[]> | undefined;
    if (!conflictMap) { return conflicts; }

    for (const [lockedFramework, conflictingFrameworks] of Object.entries(conflictMap)) {
      const isLocked = Object.values(mergedLock).includes(lockedFramework);
      if (!isLocked) { continue; }

      for (const conflicting of conflictingFrameworks) {
        if (this._contentMentionsFramework(content, conflicting)) {
          // Find what category the locked framework belongs to
          const category = this._findCategory(lockedFramework);
          conflicts.push({ detected: conflicting, locked: lockedFramework, category });
        }
      }
    }

    return conflicts;
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private _contentMentionsFramework(content: string, framework: string): boolean {
    // Simple heuristic: check for import/require of the framework
    const escaped = framework.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:import|require).*['"]${escaped}`, 'i').test(content);
  }

  private _findCategory(framework: string): string {
    for (const [category, depMap] of Object.entries(this._patterns)) {
      if (category === 'configFiles' || category === 'conflictImportPrefixes') { continue; }
      if (Object.values(depMap as Record<string, string>).includes(framework)) {
        return category;
      }
    }
    return 'unknown';
  }
}
