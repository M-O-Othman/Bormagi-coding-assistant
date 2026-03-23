/**
 * CommandBuilder — platform-aware shell command generation.
 *
 * Bug-fix-009 Fix 1.3:
 * Prevents the agent from emitting Unix-only shell syntax on Windows.
 * Unix commands like `head`, `find . -type f | head -20`, and `mkdir -p`
 * fail silently or noisily on Windows without WSL.
 *
 * Preferred approach: avoid shell discovery entirely when READY/preloaded
 * inputs already exist (see AgentRunner READY-override logic).
 * When shell commands are unavoidable, use this builder.
 */

export type HostPlatform = 'windows' | 'posix';

/**
 * Detect the current host OS.
 * Returns 'windows' if running on Win32, 'posix' otherwise.
 */
export function detectHostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'windows' : 'posix';
}

// ─── Source file listing ──────────────────────────────────────────────────────

/**
 * Build a cross-platform command to list common source files in the workspace.
 *
 * Windows: uses `dir /s /b` with extension filters (no `head` equivalent needed
 *          — the output is naturally bounded by the file count).
 * POSIX:   uses `find` with `-name` patterns and `head -20` to bound output.
 */
export function buildListSourceFilesCommand(platform: HostPlatform = detectHostPlatform()): string {
  if (platform === 'windows') {
    // dir /s /b lists all matching files recursively with full paths.
    // Separate calls are needed per extension because cmd doesn't support
    // glob alternation in a single pass; PowerShell Get-ChildItem is cleaner.
    return (
      'powershell -NoProfile -Command ' +
      '"Get-ChildItem -Recurse -Include *.py,*.js,*.ts,*.json,requirements.txt,package.json ' +
      '| Select-Object -First 30 -ExpandProperty FullName"'
    );
  }

  return (
    'find . -type f ' +
    '\\( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "*.json" ' +
    '-o -name "requirements.txt" -o -name "package.json" \\) ' +
    '| head -20'
  );
}

// ─── Directory creation ───────────────────────────────────────────────────────

/**
 * Build a cross-platform command to create a directory (and any missing parents).
 *
 * Windows: `mkdir` errors if the directory exists unless we use /Q, so we use
 *          PowerShell's `New-Item -Force` which is idempotent.
 * POSIX:   `mkdir -p` is idempotent.
 */
export function buildMkdirCommand(dirPath: string, platform: HostPlatform = detectHostPlatform()): string {
  if (platform === 'windows') {
    return `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${dirPath}'"`;
  }
  return `mkdir -p "${dirPath}"`;
}

// ─── File existence check ─────────────────────────────────────────────────────

/**
 * Build a cross-platform command to check whether a file exists.
 */
export function buildFileExistsCommand(filePath: string, platform: HostPlatform = detectHostPlatform()): string {
  if (platform === 'windows') {
    return `powershell -NoProfile -Command "Test-Path '${filePath}'"`;
  }
  return `test -f "${filePath}" && echo "exists" || echo "not found"`;
}

// ─── Package install ──────────────────────────────────────────────────────────

/**
 * Build a cross-platform npm install command.
 * The command is the same across platforms, but we note Windows CI quirks.
 */
export function buildNpmInstallCommand(platform: HostPlatform = detectHostPlatform()): string {
  // npm itself is cross-platform; no special handling needed.
  // We include platform in the signature for future use.
  void platform;
  return 'npm install --prefer-offline';
}
