import * as fs from 'fs/promises';
import * as path from 'path';

export interface ConsistencyIssue {
  path: string;
  issue: string;
}

/**
 * Lightweight post-write consistency checker (#8).
 *
 * Checks that files written during a session are internally consistent —
 * e.g. that package.json exists when JS/TS files were created, that script
 * entry points referenced in package.json exist on disk, and that the main
 * field resolves to a real file.
 *
 * This is intentionally minimal: it targets the most common mistakes that
 * agents make when scaffolding new projects and are not caught by the disk-
 * existence check in verifyWrittenFiles().
 */
export class ConsistencyValidator {
  constructor(private readonly workspaceRoot: string) {}

  /** Run after a session ends with written files. Returns issues found. */
  async validate(writtenPaths: string[]): Promise<ConsistencyIssue[]> {
    const issues: ConsistencyIssue[] = [];
    const abs = (p: string) => path.resolve(this.workspaceRoot, p);
    const exists = (p: string) => fs.access(abs(p)).then(() => true).catch(() => false);
    const normalize = (p: string) => p.replace(/^\.\//, '');

    // Check 1: .ts/.js files were written → package.json should exist
    const hasCode = writtenPaths.some(p => /\.[jt]sx?$/.test(p));
    if (hasCode && !await exists('package.json')) {
      issues.push({
        path: 'package.json',
        issue: 'TypeScript/JavaScript files were written but no package.json exists in the workspace root.',
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
        };

        // Check scripts: look for `node ./path/file.js` or `ts-node ./path/file.ts` patterns
        for (const [scriptName, cmd] of Object.entries(pkg.scripts ?? {})) {
          const fileRef = String(cmd).match(/(?:node|ts-node)\s+([\w./][^\s]*\.[jt]s)/)?.[1];
          if (fileRef && !await exists(fileRef)) {
            issues.push({
              path: fileRef,
              issue: `Script "${scriptName}" references "${fileRef}" which does not exist on disk.`,
            });
          }
        }

        // Check main / module entry point
        if (pkg.main && !await exists(pkg.main)) {
          issues.push({
            path: pkg.main,
            issue: `package.json "main" field points to "${pkg.main}" which does not exist on disk.`,
          });
        }
      } catch {
        // Corrupt or unparseable package.json — skip content checks
      }
    }

    return issues;
  }
}
