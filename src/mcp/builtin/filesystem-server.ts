/**
 * Built-in MCP filesystem server (stdio transport).
 * Provides: read_file, write_file, list_files, search_files.
 * Restricts all operations to the workspace root supplied as the first CLI argument.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const workspaceRoot = process.argv[2] ?? process.cwd();

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────────

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id: number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

// ─── Guard: only allow paths inside workspace ──────────────────────────────────

function resolveSafe(filePath: string): string {
  const resolved = path.resolve(workspaceRoot, filePath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error('Access denied: path is outside the workspace.');
  }
  return resolved;
}

// ─── Tool implementations ──────────────────────────────────────────────────────

function readFile(args: { path: string }): string {
  const safe = resolveSafe(args.path);
  return fs.readFileSync(safe, 'utf8');
}

function writeFile(args: { path: string; content: string }): string {
  const safe = resolveSafe(args.path);
  const dir = path.dirname(safe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(safe, args.content, 'utf8');
  return `File written: ${args.path}`;
}

function listFiles(args: { directory?: string }): string {
  const dir = resolveSafe(args.directory ?? '.');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
    .join('\n');
}

function searchFiles(args: { pattern: string; directory?: string }): string {
  const searchDir = resolveSafe(args.directory ?? '.');
  const results: string[] = [];
  const regex = new RegExp(args.pattern, 'i');

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.bormagi'].includes(entry.name)) {
          walk(full);
        }
      } else {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              const rel = path.relative(workspaceRoot, full);
              results.push(`${rel}:${idx + 1}: ${line.trim()}`);
            }
          });
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  }

  walk(searchDir);
  return results.length > 0 ? results.join('\n') : 'No matches found.';
}

// ─── MCP protocol handler ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path to the file.' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file.' },
        content: { type: 'string', description: 'Full content to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files and directories inside a workspace directory.',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string', description: 'Relative directory path. Defaults to root.' } }
    }
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern (regex) across workspace files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        directory: { type: 'string', description: 'Limit search to this directory. Defaults to root.' }
      },
      required: ['pattern']
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
      respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'filesystem', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const toolName = (params as { name: string; arguments: Record<string, unknown> }).name;
      const args = (params as { name: string; arguments: Record<string, unknown> }).arguments;
      let text = '';

      if (toolName === 'read_file') text = readFile(args as { path: string });
      else if (toolName === 'write_file') text = writeFile(args as { path: string; content: string });
      else if (toolName === 'list_files') text = listFiles(args as { directory?: string });
      else if (toolName === 'search_files') text = searchFiles(args as { pattern: string; directory?: string });
      else throw new Error(`Unknown tool: ${toolName}`);

      respond(id, { content: [{ type: 'text', text }] });
    } else {
      respondError(id, `Unknown method: ${method}`);
    }
  } catch (err) {
    respond(id, { content: [{ type: 'text', text: String(err) }], isError: true });
  }
});
