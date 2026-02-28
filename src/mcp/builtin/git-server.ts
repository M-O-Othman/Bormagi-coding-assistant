/**
 * Built-in MCP git server (stdio transport).
 * Provides: git_status, git_diff, git_commit, git_log.
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

function git(args: string): string {
  try {
    return childProcess.execSync(`git ${args}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 15000
    });
  } catch (err) {
    const execErr = err as childProcess.SpawnSyncReturns<string>;
    return (execErr.stdout ?? '') + '\n' + (execErr.stderr ?? '');
  }
}

const TOOLS = [
  {
    name: 'git_status',
    description: 'Show the current git working tree status.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'git_diff',
    description: 'Show git diff. Pass staged:true to see staged changes.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged changes (default: false = unstaged).' },
        path: { type: 'string', description: 'Limit diff to a specific file path.' }
      }
    }
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and create a git commit. Requires user approval (enforced by the extension).',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Specific files to stage. Omit to stage all.' }
      },
      required: ['message']
    }
  },
  {
    name: 'git_log',
    description: 'Show recent git commit log.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits to show (default: 10).' }
      }
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
      respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'git', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = (params as { name: string; arguments: Record<string, unknown> }).name;
      const args = (params as { name: string; arguments: Record<string, unknown> }).arguments ?? {};
      let text = '';

      if (toolName === 'git_status') {
        text = git('status');
      } else if (toolName === 'git_diff') {
        const diffArgs = args as { staged?: boolean; path?: string };
        const staged = diffArgs.staged ? '--staged' : '';
        const filePath = diffArgs.path ? `-- "${diffArgs.path}"` : '';
        text = git(`diff ${staged} ${filePath}`.trim());
      } else if (toolName === 'git_commit') {
        const commitArgs = args as { message: string; files?: string[] };
        if (commitArgs.files && commitArgs.files.length > 0) {
          const fileList = commitArgs.files.map(f => `"${f}"`).join(' ');
          git(`add ${fileList}`);
        } else {
          git('add -A');
        }
        text = git(`commit -m "${commitArgs.message.replace(/"/g, '\\"')}"`);
      } else if (toolName === 'git_log') {
        const logArgs = args as { count?: number };
        const count = logArgs.count ?? 10;
        text = git(`log --oneline -n ${count}`);
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      respond(id, { content: [{ type: 'text', text }] });
    } else {
      respond(id, { content: [{ type: 'text', text: `Unknown method: ${method}` }], isError: true });
    }
  } catch (err) {
    respond(id, { content: [{ type: 'text', text: String(err) }], isError: true });
  }
});
