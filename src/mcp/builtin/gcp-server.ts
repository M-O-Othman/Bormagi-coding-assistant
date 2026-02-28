/**
 * Built-in MCP GCP server (stdio transport).
 * Provides: gcp_auth_status, gcp_deploy.
 * Requires gcloud CLI to be installed and on PATH.
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

/**
 * Run gcloud with a structured argument array — no shell string interpolation.
 * This prevents injection via project IDs, service names, or other user-supplied values.
 */
function gcloud(args: string[], cwd?: string): string {
  try {
    return childProcess.execFileSync('gcloud', args, {
      cwd: cwd ?? workspaceRoot,
      encoding: 'utf8',
      timeout: 120000
    });
  } catch (err) {
    const execErr = err as childProcess.SpawnSyncReturns<string>;
    return (execErr.stdout ?? '') + '\n' + (execErr.stderr ?? '');
  }
}

const TOOLS = [
  {
    name: 'gcp_auth_status',
    description: 'Check the current Google Cloud CLI authentication status and active project.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'gcp_deploy',
    description: 'Run a gcloud deployment command in the workspace. Requires user approval (enforced by the extension).',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The gcloud sub-command and flags (e.g. "run deploy my-service --image gcr.io/project/image --region us-central1").'
        },
        project: {
          type: 'string',
          description: 'GCP project ID. If omitted, the active gcloud project is used.'
        }
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
      respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gcp', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = (params as { name: string; arguments: Record<string, unknown> }).name;
      const args = (params as { name: string; arguments: Record<string, unknown> }).arguments ?? {};
      let text = '';

      if (toolName === 'gcp_auth_status') {
        const authList = gcloud(['auth', 'list']);
        const config = gcloud(['config', 'list', 'project']);
        text = `=== Auth Accounts ===\n${authList}\n=== Active Project ===\n${config}`;
      } else if (toolName === 'gcp_deploy') {
        const deployArgs = args as { command: string; project?: string };
        // Split the command string into tokens for safe arg-array execution.
        // The agent supplies a sub-command string (e.g. "run deploy svc --image ...").
        // We split on whitespace; quoted arguments are not supported here, but gcloud
        // flags are always space-separated in practice.
        const tokens = deployArgs.command.trim().split(/\s+/);
        if (deployArgs.project) { tokens.push('--project'); tokens.push(deployArgs.project); }
        text = gcloud(tokens);
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
