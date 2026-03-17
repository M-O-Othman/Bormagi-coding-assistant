import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export type ToolStatus = 'available' | 'missing' | 'error';

export interface ToolCheck {
  name: string;
  status: ToolStatus;
  version: string | null;
  /** What this tool enables in Bormagi */
  purpose: string;
  /** What won't work if this tool is missing */
  impact: string;
  /** How to install it */
  installHint: string;
}

export interface EnvironmentReport {
  /** Host OS info */
  os: {
    platform: string;
    release: string;
    arch: string;
    /** e.g. "Windows 11", "macOS 14", "Ubuntu 22.04" */
    friendly: string;
  };
  /** Path separator and known issues */
  pathInfo: {
    separator: string;
    isWindows: boolean;
    /** Warns about backslash path issues */
    warnings: string[];
  };
  /** Detected shell */
  shell: string;
  /** Node.js runtime (always available since we're in VS Code) */
  nodeVersion: string;
  /** Per-tool checks */
  tools: ToolCheck[];
  /** Summary counts */
  summary: {
    available: number;
    missing: number;
    errors: number;
  };
  /** Timestamp */
  checkedAt: string;
}

export class EnvironmentChecker {

  /**
   * Run all environment checks and return a full report.
   * Each check has a 5s timeout to avoid blocking activation.
   */
  async check(): Promise<EnvironmentReport> {
    const platform = os.platform();
    const release = os.release();
    const arch = os.arch();
    const isWindows = platform === 'win32';

    const friendly = this.getFriendlyOS(platform, release);
    const shell = process.env.SHELL || process.env.COMSPEC || 'unknown';

    const pathWarnings: string[] = [];
    if (isWindows) {
      pathWarnings.push('Windows uses backslash (\\) paths — Bormagi normalizes to forward slashes internally.');
      if ((process.env.PATH?.length ?? 0) > 8000) {
        pathWarnings.push('PATH is very long — some tools may fail to resolve. Consider cleaning up PATH entries.');
      }
    }

    // Run all tool checks in parallel
    const tools = await Promise.all([
      this.checkTool('git', 'git --version', /git version ([\d.]+)/, {
        purpose: 'Version control, diff tracking, checkpoint/undo',
        impact: 'Git-based features disabled: checkpoints, undo, diff previews, commit suggestions',
        installHint: isWindows
          ? 'Download from https://git-scm.com/download/win'
          : 'Install via package manager (apt install git / brew install git)'
      }),
      this.checkTool('npm', 'npm --version', /^([\d.]+)/, {
        purpose: 'Runs lint, test, and typecheck validation after code generation',
        impact: 'Post-session validation skipped (lint, test, typecheck). File writes still work normally.',
        installHint: 'Install Node.js from https://nodejs.org (npm is bundled with Node.js)'
      }),
      this.checkTool('node', 'node --version', /v?([\d.]+)/, {
        purpose: 'JavaScript/TypeScript runtime (required by VS Code)',
        impact: 'Extension cannot run without Node.js (provided by VS Code)',
        installHint: 'Node.js is bundled with VS Code — if missing, reinstall VS Code'
      }),
      this.checkTool('python', this.getPythonCmd(isWindows), /Python ([\d.]+)/, {
        purpose: 'Python project support, MCP servers that use Python',
        impact: 'Python-based MCP servers and Python project validation unavailable',
        installHint: isWindows
          ? 'Download from https://python.org or run: winget install Python.Python.3'
          : 'Install via package manager (apt install python3 / brew install python3)'
      }),
      this.checkTool('gcloud', 'gcloud --version', /Google Cloud SDK ([\d.]+)/, {
        purpose: 'GCP Vertex AI authentication (ADC/OAuth)',
        impact: 'Cannot use Vertex AI auth method. Use API key auth for Gemini instead.',
        installHint: 'Install from https://cloud.google.com/sdk/docs/install'
      }),
      this.checkTool('docker', 'docker --version', /Docker version ([\d.]+)/, {
        purpose: 'Container-based sandbox isolation for agent file writes',
        impact: 'Sandbox mode unavailable — agents write directly to workspace',
        installHint: isWindows
          ? 'Install Docker Desktop from https://docker.com/products/docker-desktop'
          : 'Install via package manager or https://docs.docker.com/engine/install'
      }),
      this.checkTool('code', 'code --version', /^([\d.]+)/, {
        purpose: 'VS Code CLI for extension management',
        impact: 'Minor — CLI extension commands unavailable',
        installHint: 'Should be available with VS Code. Check "Shell Command: Install code in PATH"'
      }),
    ]);

    const summary = {
      available: tools.filter(t => t.status === 'available').length,
      missing: tools.filter(t => t.status === 'missing').length,
      errors: tools.filter(t => t.status === 'error').length,
    };

    return {
      os: { platform, release, arch, friendly },
      pathInfo: { separator: path.sep, isWindows, warnings: pathWarnings },
      shell,
      nodeVersion: process.version,
      tools,
      summary,
      checkedAt: new Date().toISOString(),
    };
  }

  private async checkTool(
    name: string,
    command: string,
    versionRegex: RegExp,
    meta: { purpose: string; impact: string; installHint: string }
  ): Promise<ToolCheck> {
    try {
      const { stdout, stderr } = await execAsync(command, { timeout: 5000 });
      const output = (stdout + '\n' + stderr).trim();
      const match = output.match(versionRegex);
      return {
        name,
        status: 'available',
        version: match?.[1] ?? output.split('\n')[0].slice(0, 60),
        ...meta,
      };
    } catch (err: any) {
      // Distinguish "not found" from other errors
      const msg = String(err?.message || '');
      const isNotFound = msg.includes('ENOENT') || msg.includes('not recognized') ||
        msg.includes('not found') || msg.includes('command not found') ||
        err?.code === 'ENOENT' || err?.code === 127;

      return {
        name,
        status: isNotFound ? 'missing' : 'error',
        version: null,
        ...meta,
      };
    }
  }

  private getPythonCmd(isWindows: boolean): string {
    // Windows: try `python` first (py launcher often maps to it)
    // Unix: `python3` is more reliable
    return isWindows ? 'python --version' : 'python3 --version';
  }

  private getFriendlyOS(platform: string, release: string): string {
    switch (platform) {
      case 'win32': {
        const major = parseInt(release.split('.')[0], 10);
        const build = parseInt(release.split('.')[2] ?? '0', 10);
        if (major >= 10 && build >= 22000) return `Windows 11 (${release})`;
        if (major >= 10) return `Windows 10 (${release})`;
        return `Windows (${release})`;
      }
      case 'darwin': {
        const ver = parseInt(release.split('.')[0], 10);
        // Darwin 23 = macOS 14 Sonoma, 22 = Ventura, etc.
        const macVer = ver >= 20 ? ver - 9 : ver - 4;
        return `macOS ${macVer} (Darwin ${release})`;
      }
      case 'linux': {
        // Try to read /etc/os-release for a better name
        try {
          const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
          const match = osRelease.match(/PRETTY_NAME="?([^"\n]+)"?/);
          if (match) return match[1];
        } catch { /* ignore */ }
        return `Linux (${release})`;
      }
      default:
        return `${platform} (${release})`;
    }
  }
}
