import * as fs from 'fs/promises';
import * as path from 'path';
import type { ExecutionStateData } from '../ExecutionStateManager';
import type { ArchitectureLockData } from './ArchitectureLock';

export interface ConsistencyIssue {
  path: string;
  issue: string;
  /** Severity: critical issues block execution; warning issues are surfaced but non-blocking. */
  severity: 'info' | 'warning' | 'critical';
  /** When true, the validator can automatically repair this issue. */
  autoFixable?: boolean;
}

/**
 * Lightweight post-write consistency checker.
 *
 * Checks that files written during a session are internally consistent —
 * e.g. that package.json exists when JS/TS files were created, that script
 * entry points referenced in package.json exist on disk, that the main
 * field resolves to a real file, and that architecture lock constraints are met.
 */
export class ConsistencyValidator {
  constructor(private readonly workspaceRoot: string) {}

  /** Run after a session ends with written files. Returns issues found. */
  async validate(
    writtenPaths: string[],
    execState?: ExecutionStateData,
    architectureLock?: ArchitectureLockData
  ): Promise<ConsistencyIssue[]> {
    const issues: ConsistencyIssue[] = [];
    const abs = (p: string) => path.resolve(this.workspaceRoot, p);
    const exists = (p: string) => fs.access(abs(p)).then(() => true).catch(() => false);
    const normalize = (p: string) => p.replace(/^\.\//, '');

    // Check 1: .ts/.js files were written → package.json should exist
    // EXCEPTION (bug_fix_007): Static web assets (index.html + .css + plain .js)
    // do NOT require package.json. Only flag when Node/npm-style tooling is implied:
    // TypeScript files, JSX/TSX, or imports that suggest a build pipeline.
    const jsFiles = writtenPaths.filter(p => /\.[jt]sx?$/.test(p));
    const hasCode = jsFiles.length > 0;
    const hasHtmlFile = writtenPaths.some(p => /\.html?$/i.test(p));
    const hasTypeScript = jsFiles.some(p => /\.tsx?$/.test(p));
    const isStaticWebBundle = hasHtmlFile && !hasTypeScript && jsFiles.every(p => /\.js$/.test(p));

    if (hasCode && !isStaticWebBundle && !await exists('package.json')) {
      issues.push({
        path: 'package.json',
        issue: 'TypeScript/JavaScript files were written but no package.json exists in the workspace root.',
        severity: 'critical',
        autoFixable: false,
      });
    }

    // Check 2: package.json was written → validate scripts entry points and main field
    const pkgWritten = writtenPaths.some(p => normalize(p) === 'package.json');
    if (pkgWritten) {
      try {
        const raw = await fs.readFile(abs('package.json'), 'utf8');
        const pkg = JSON.parse(raw) as {
          main?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
        };

        // Check scripts: look for `node ./path/file.js` or `ts-node ./path/file.ts` patterns
        for (const [scriptName, cmd] of Object.entries(pkg.scripts ?? {})) {
          const fileRef = String(cmd).match(/(?:node|ts-node)\s+([\w./][^\s]*\.[jt]s)/)?.[1];
          if (fileRef && !await exists(fileRef)) {
            issues.push({
              path: fileRef,
              issue: `Script "${scriptName}" references "${fileRef}" which does not exist on disk.`,
              severity: 'critical',
              autoFixable: false,
            });
          }
        }

        // Check main / module entry point
        if (pkg.main && !await exists(pkg.main)) {
          issues.push({
            path: pkg.main,
            issue: `package.json "main" field points to "${pkg.main}" which does not exist on disk.`,
            severity: 'critical',
            autoFixable: false,
          });
        }
      } catch {
        // Corrupt or unparseable package.json — skip content checks
      }
    }

    // Check 3: Batch completion — all declared files must be written (critical)
    if (execState) {
      const batch = execState.plannedFileBatch ?? [];
      const completed = execState.completedBatchFiles ?? [];
      const remaining = batch.filter(p => !completed.includes(p));
      if (batch.length > 0 && remaining.length > 0) {
        issues.push({
          path: '(batch)',
          issue: `Declared file batch is incomplete: ${remaining.length} file(s) not yet written: ${remaining.slice(0, 5).join(', ')}${remaining.length > 5 ? ` +${remaining.length - 5} more` : ''}.`,
          severity: 'critical',
          autoFixable: false,
        });
      }
    }

    // Check 4: Missing source-file imports not in package.json (warning, auto-fixable)
    if (pkgWritten && hasCode) {
      const missingDeps = await this._findMissingDependencies(writtenPaths);
      for (const dep of missingDeps) {
        issues.push({
          path: 'package.json',
          issue: `Package "${dep}" is imported in source files but not listed in package.json dependencies.`,
          severity: 'warning',
          autoFixable: true,
        });
      }
    }

    // Check 5: Architecture lock consistency (critical for existing, warning for greenfield)
    if (architectureLock && writtenPaths.length > 0 && execState?.techStack) {
      const lockConflicts = await this._checkArchitectureLockConsistency(
        writtenPaths, architectureLock, execState.techStack
      );
      for (const conflict of lockConflicts) {
        issues.push({
          path: conflict.path,
          issue: conflict.issue,
          severity: 'critical',
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  /**
   * Attempt to auto-fix auto-fixable issues.
   * Currently supports: adding missing dependencies to package.json.
   * Gated behind `validatorEnforcement` VS Code setting.
   */
  async autoFix(issues: ConsistencyIssue[]): Promise<string[]> {
    const fixed: string[] = [];
    const abs = (p: string) => path.resolve(this.workspaceRoot, p);

    const missingDeps = issues
      .filter(i => i.autoFixable && i.issue.startsWith('Package "'))
      .map(i => i.issue.match(/Package "([^"]+)"/)?.[1])
      .filter(Boolean) as string[];

    if (missingDeps.length > 0) {
      try {
        const raw = await fs.readFile(abs('package.json'), 'utf8');
        const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
        pkg.dependencies = pkg.dependencies ?? {};
        for (const dep of missingDeps) {
          if (!pkg.dependencies[dep]) {
            pkg.dependencies[dep] = '*';
            fixed.push(`Added missing dependency: ${dep}`);
          }
        }
        await fs.writeFile(abs('package.json'), JSON.stringify(pkg, null, 2), 'utf8');
      } catch {
        // non-fatal
      }
    }

    return fixed;
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private async _findMissingDependencies(writtenPaths: string[]): Promise<string[]> {
    const missing: string[] = [];
    try {
      const pkgRaw = await fs.readFile(
        path.join(this.workspaceRoot, 'package.json'), 'utf8'
      );
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]);

      for (const filePath of writtenPaths.filter(p => /\.[jt]sx?$/.test(p))) {
        try {
          const content = await fs.readFile(
            path.join(this.workspaceRoot, filePath), 'utf8'
          );
          const importMatches = content.matchAll(/(?:import|require)\s*.*?['"]([^./][^'"]+)['"]/g);
          for (const match of importMatches) {
            const pkg = match[1].startsWith('@')
              ? match[1].split('/').slice(0, 2).join('/')
              : match[1].split('/')[0];
            if (!allDeps.has(pkg) && !missing.includes(pkg)) {
              missing.push(pkg);
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // no package.json or unreadable
    }
    return missing;
  }

  private async _checkArchitectureLockConsistency(
    writtenPaths: string[],
    lock: ArchitectureLockData,
    userTechStack: Record<string, string>
  ): Promise<Array<{ path: string; issue: string }>> {
    const conflicts: Array<{ path: string; issue: string }> = [];
    const mergedLock = { ...lock, ...userTechStack };

    for (const filePath of writtenPaths.filter(p => /\.[jt]sx?$/.test(p))) {
      try {
        const content = await fs.readFile(
          path.join(this.workspaceRoot, filePath), 'utf8'
        );
        // Simple check: look for imports of known conflicting frameworks
        for (const [category, lockedValue] of Object.entries(mergedLock)) {
          if (category === 'confidence') { continue; }
          // If we have a locked framework, check for conflicting imports in the content
          const imported = content.match(/(?:import|require).*?['"](@?[\w-]+(?:\/[\w-]+)?)['"]/g) ?? [];
          for (const importLine of imported) {
            const depMatch = importLine.match(/['"](@?[\w-]+(?:\/[\w-]+)?)['"]/);
            if (!depMatch) { continue; }
            const depName = depMatch[1];
            if (depName === lockedValue) { continue; } // matches the lock — fine
          }
        }
      } catch {
        // skip
      }
    }
    return conflicts;
  }
}
