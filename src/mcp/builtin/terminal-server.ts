/**
 * Built-in MCP terminal server (stdio transport).
 * Provides: run_command.
 * NOTE: The approval gate is enforced at the AgentRunner level in the extension host,
 * not here. This server executes whatever command it receives — the caller is responsible
 * for obtaining user consent before invoking run_command.
 */
import * as childProcess from 'child_process';
import * as readline from 'readline';

const workspaceRoot = process.argv[2] ?? process.cwd();

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id: number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function runCommand(args: { command: string; cwd?: string }): string {
  const cwd = args.cwd ?? workspaceRoot;
  try {
    const output = childProcess.execSync(args.command, {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 10
    });
    return output;
  } catch (err) {
    const execErr = err as childProcess.SpawnSyncReturns<string>;
    return execErr.stdout + '\n' + execErr.stderr;
  }
}

const TOOLS = [
  {
    name: 'run_command',
    description: 'Execute a shell command in the workspace directory. Requires user approval before execution (enforced by the extension).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to workspace root.' }
      },
      required: ['command']
    }
  }
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
