/**
 * Built-in MCP terminal server (stdio transport).
 * Provides: run_command.
 * NOTE: The approval gate is enforced at the AgentRunner level in the extension host,
 * not here. This server executes whatever command it receives — the caller is responsible
 * for obtaining user consent before invoking run_command.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const workspaceRoot = process.argv[2] ?? process.cwd();
const IS_WINDOWS = process.platform === 'win32';

/** Strings that Windows CMD prints to stdout on error (exit code is still 0). */
const WINDOWS_STDOUT_ERRORS = [
  'The syntax of the command is incorrect',
  'is not recognized as an internal or external command',
  'Access is denied',
  'The system cannot find the path specified',
  'The system cannot find the file specified',
];

function detectWindowsStdoutError(output: string): string | null {
  for (const pattern of WINDOWS_STDOUT_ERRORS) {
    if (output.includes(pattern)) { return pattern; }
  }
  return null;
}

/**
 * Translate a Unix-style command to its Windows equivalent.
 * Returns the translated command string, or the original if no translation applies.
 */
function translateForWindows(command: string): string {
  // mkdir -p <path>  →  fs.mkdirSync (handled separately below; here we replace with PowerShell)
  const mkdirMatch = command.match(/^mkdir\s+-p\s+(.+)$/);
  if (mkdirMatch) {
    const dirArg = mkdirMatch[1].trim();
    // Use PowerShell's New-Item which is always available on Windows 7+
    return `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${dirArg}' | Out-Null"`;
  }

  // rm -rf <path>  →  PowerShell Remove-Item
  const rmMatch = command.match(/^rm\s+-rf?\s+(.+)$/);
  if (rmMatch) {
    const target = rmMatch[1].trim();
    return `powershell -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${target}'"`;
  }

  // cp -r <src> <dest>  →  PowerShell Copy-Item
  const cpMatch = command.match(/^cp\s+-r\s+(\S+)\s+(\S+)$/);
  if (cpMatch) {
    const src = cpMatch[1];
    const dest = cpMatch[2];
    return `powershell -NoProfile -Command "Copy-Item -Recurse -Force '${src}' '${dest}'"`;
  }

  return command;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id: number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

/**
 * Resolve and validate a working-directory argument against the workspace root.
 * Uses path.relative() to detect traversal — same strategy as the filesystem server.
 * Falls back to workspaceRoot when no cwd is specified.
 */
function resolveCwd(requestedCwd?: string): string {
  if (!requestedCwd) {
    return workspaceRoot;
  }
  const resolved = path.resolve(workspaceRoot, requestedCwd);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Access denied: working directory "${requestedCwd}" is outside the workspace.`);
  }
  return resolved;
}

function runCommand(args: { command: string; cwd?: string }): string {
  const cwd = resolveCwd(args.cwd);
  const command = IS_WINDOWS ? translateForWindows(args.command) : args.command;
  try {
    const output = childProcess.execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 10
    });
    // On Windows, CMD may return exit code 0 even on errors — check stdout content.
    if (IS_WINDOWS) {
      const winErr = detectWindowsStdoutError(output);
      if (winErr) {
        return `[Error] Command failed (Windows stdout error): ${winErr}\nOutput: ${output.trim()}`;
      }
    }
    // Return a normalised success message when the command produced no output,
    // so the LLM knows it succeeded and doesn't retry indefinitely.
    return output.trim() || 'Done.';
  } catch (err) {
    const execErr = err as childProcess.SpawnSyncReturns<string>;
    return (execErr.stdout ?? '') + '\n' + (execErr.stderr ?? '');
  }
}

const TOOLS: any[] = [
  // Deprecated: `run_command` has been removed from public skills 
  // to force the LLM to use the SemanticGateway (bug-fixes-12).
];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req: { jsonrpc: string; id: number; method: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    return;
  }

  const { id, method, params } = req;

  try {
    if (method === 'initialize') {
      respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'terminal', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = (params as { name: string; arguments: Record<string, unknown> }).name;
      const args = (params as { name: string; arguments: Record<string, unknown> }).arguments;

      if (toolName === 'run_command') {
        const text = runCommand(args as { command: string; cwd?: string });
        respond(id, { content: [{ type: 'text', text }] });
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }
    } else {
      respond(id, { content: [{ type: 'text', text: `Unknown method: ${method}` }], isError: true });
    }
  } catch (err) {
    respond(id, { content: [{ type: 'text', text: String(err) }], isError: true });
  }
});
