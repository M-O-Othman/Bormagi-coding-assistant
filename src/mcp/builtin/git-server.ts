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
  },
  {
    name: 'git_create_branch',
    description: 'Create a new git branch. Optionally switch to it immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Branch name.' },
        checkout: { type: 'boolean', description: 'Switch to the new branch after creating it (default: true).' }
      },
      required: ['name']
    }
  },
  {
    name: 'git_push',
    description: 'Push the current branch to a remote. Requires user approval (enforced by the extension).',
    inputSchema: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name (default: origin).' },
        branch: { type: 'string', description: 'Branch to push (default: current branch).' },
        set_upstream: { type: 'boolean', description: 'Set upstream tracking (-u flag, default: false).' }
      }
    }
  },
  {
    name: 'git_create_pr',
    description: 'Create a GitHub pull request using the gh CLI. Requires user approval (enforced by the extension).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR description body.' },
        base: { type: 'string', description: 'Base branch (default: main).' },
        draft: { type: 'boolean', description: 'Open as a draft PR (default: false).' }
      },
      required: ['title']
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
      } else if (toolName === 'git_create_branch') {
        const branchArgs = args as { name: string; checkout?: boolean };
        const shouldCheckout = branchArgs.checkout !== false;
        text = shouldCheckout
          ? git(`checkout -b ${branchArgs.name}`)
          : git(`branch ${branchArgs.name}`);
      } else if (toolName === 'git_push') {
        const pushArgs = args as { remote?: string; branch?: string; set_upstream?: boolean };
        const remote = pushArgs.remote ?? 'origin';
        const branch = pushArgs.branch ?? '';
        const upstream = pushArgs.set_upstream ? '--set-upstream ' : '';
        text = git(`push ${upstream}${remote}${branch ? ' ' + branch : ''}`.trim());
      } else if (toolName === 'git_create_pr') {
        const prArgs = args as { title: string; body?: string; base?: string; draft?: boolean };
        const title = prArgs.title.replace(/"/g, '\\"');
        const body = (prArgs.body ?? '').replace(/"/g, '\\"');
        const base = prArgs.base ? `--base "${prArgs.base}"` : '';
        const draft = prArgs.draft ? '--draft' : '';
        const cmd = `pr create --title "${title}"${body ? ` --body "${body}"` : ''} ${base} ${draft}`.trim();
        text = childProcess.execSync(`gh ${cmd}`, { cwd: workspaceRoot, encoding: 'utf8', timeout: 30000 });
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
