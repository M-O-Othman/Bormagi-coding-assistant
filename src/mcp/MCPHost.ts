import * as childProcess from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { MCPServerConfig, MCPToolDefinition, MCPToolCall, MCPToolResult } from '../types';
import { AuditLogger } from '../audit/AuditLogger';

interface PendingRequest {
  resolve: (value: MCPToolResult) => void;
  reject: (reason: unknown) => void;
}

interface MCPServerProcess {
  config: MCPServerConfig;
  process: childProcess.ChildProcess;
  tools: MCPToolDefinition[];
  pendingRequests: Map<number, PendingRequest>;
  nextId: number;
}

/**
 * MCPHost manages the lifecycle of MCP server child processes (stdio transport).
 * It launches servers, discovers their tools via the MCP initialize/list_tools handshake,
 * and routes tool call requests back and forth.
 */
export class MCPHost {
  private servers = new Map<string, MCPServerProcess>();
  private builtinServersDir: string;

  constructor(
    extensionPath: string,
    private readonly auditLogger: AuditLogger
  ) {
    this.builtinServersDir = path.join(extensionPath, 'dist', 'mcp-servers');
  }

  /**
   * Start a built-in MCP server by name (e.g. 'filesystem', 'terminal', 'git', 'gcp').
   */
  async startBuiltin(name: string, workspaceRoot: string): Promise<MCPToolDefinition[]> {
    const serverScript = path.join(this.builtinServersDir, `${name}-server.js`);
    return this.startServer({
      name,
      command: 'node',
      args: [serverScript, workspaceRoot],
      env: {}
    });
  }

  /**
   * Start a user-configured custom MCP server.
   */
  async startServer(config: MCPServerConfig): Promise<MCPToolDefinition[]> {
    if (this.servers.has(config.name)) {
      return this.servers.get(config.name)!.tools;
    }

    const env = { ...process.env, ...config.env };
    const proc = childProcess.spawn(config.command, config.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const serverEntry: MCPServerProcess = {
      config,
      process: proc,
      tools: [],
      pendingRequests: new Map(),
      nextId: 1
    };

    this.servers.set(config.name, serverEntry);

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      this.handleServerMessage(config.name, line);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      console.error(`[MCP:${config.name}] ${data.toString()}`);
    });

    proc.on('exit', (code) => {
      console.log(`[MCP:${config.name}] exited with code ${code}`);
      this.servers.delete(config.name);
    });

    // MCP initialize handshake
    await this.sendRequest(config.name, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bormagi', version: '0.1.0' }
    });

    // Discover tools
    const listResult = await this.sendRequest(config.name, 'tools/list', {});
    const tools = (listResult as { tools?: MCPToolDefinition[] }).tools ?? [];
    serverEntry.tools = tools;

    return tools;
  }

  async callTool(serverName: string, call: MCPToolCall): Promise<MCPToolResult> {
    const server = this.servers.get(serverName);
    if (!server) {
      return {
        content: [{ type: 'text', text: `MCP server "${serverName}" is not running.` }],
        isError: true
      };
    }

    const result = await this.sendRequest(serverName, 'tools/call', {
      name: call.name,
      arguments: call.input
    }) as MCPToolResult;

    await this.auditLogger.logToolCall(serverName, call.name, call.input, result);
    return result;
  }

  async stopAll(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        server.process.kill();
      } catch {
        // Ignore errors during shutdown
      }
      this.servers.delete(name);
    }
  }

  getToolsForServer(serverName: string): MCPToolDefinition[] {
    return this.servers.get(serverName)?.tools ?? [];
  }

  getAllTools(): MCPToolDefinition[] {
    const all: MCPToolDefinition[] = [];
    for (const server of this.servers.values()) {
      all.push(...server.tools);
    }
    return all;
  }

  private sendRequest(serverName: string, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const server = this.servers.get(serverName);
      if (!server) {
        reject(new Error(`Server "${serverName}" not found`));
        return;
      }

      const id = server.nextId++;
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });

      server.pendingRequests.set(id, { resolve: resolve as (v: MCPToolResult) => void, reject });

      server.process.stdin!.write(message + '\n', 'utf8');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (server.pendingRequests.has(id)) {
          server.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method} on ${serverName}`));
        }
      }, 30000);
    });
  }

  private handleServerMessage(serverName: string, line: string): void {
    let parsed: { id?: number; result?: unknown; error?: { message: string } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }

    const server = this.servers.get(serverName);
    if (!server || parsed.id === undefined) {
      return;
    }

    const pending = server.pendingRequests.get(parsed.id);
    if (!pending) {
      return;
    }

    server.pendingRequests.delete(parsed.id);

    if (parsed.error) {
      pending.reject(new Error(parsed.error.message));
    } else {
      pending.resolve(parsed.result as MCPToolResult);
    }
  }
}
