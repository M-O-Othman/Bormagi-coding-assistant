import * as vscode from 'vscode';
import * as path from 'path';
import { MCPHost } from '../../mcp/MCPHost';
import { UndoManager } from '../UndoManager';
import { AuditLogger } from '../../audit/AuditLogger';
import { generateDocx, generatePptx } from '../../utils/DocumentGenerator';
import type { MCPToolCall, ThoughtEvent } from '../../types';
import { getAppData } from '../../data/DataStore';

import { ExecWrapper } from '../../sandbox/ExecWrapper';
import { SandboxHandle } from '../../sandbox/types';

export type ApprovalCallback = (prompt: string) => Promise<boolean>;
export type DiffCallback = (filePath: string, originalContent: string, newContent: string) => Promise<boolean>;
export type ThoughtCallback = (event: ThoughtEvent) => void;

/** Per-run guard state tracked by ToolDispatcher for Phase 3 runtime enforcement. */
interface ToolGuardState {
  mode: string;
  useV2: boolean;
  readFileCount: number;
  listFilesCount: number;
  consecutiveDiscoveryWithoutWrite: number;
  /** Map from normalised path → timestamp of last read. Cleared when file is written. */
  filesReadThisRun: Map<string, number>;
  /** Set of paths written this run — re-reading is allowed after a write. */
  filesWrittenThisRun: Set<string>;
}

/**
 * Dispatches agent tool calls to the appropriate MCP server or virtual handler.
 * Encapsulates approval gating, write-file diff flow, and document generation.
 */
export class ToolDispatcher {
  private _activeSandbox: SandboxHandle | null = null;
  private _guardState: ToolGuardState = {
    mode: '', useV2: false, readFileCount: 0, listFilesCount: 0,
    consecutiveDiscoveryWithoutWrite: 0,
    filesReadThisRun: new Map(), filesWrittenThisRun: new Set(),
  };

  constructor(
    private readonly mcpHost: MCPHost,
    private readonly undoManager: UndoManager,
    private readonly auditLogger: AuditLogger,
    private readonly workspaceRoot: string,
    private readonly execWrapper?: ExecWrapper | null
  ) { }

  public set activeSandbox(sandbox: SandboxHandle | null) {
    this._activeSandbox = sandbox;
  }

  /** Reset per-run guard state. Call at the start of each AgentRunner.run() invocation. */
  public resetGuardState(mode: string, useV2: boolean): void {
    this._guardState = {
      mode, useV2, readFileCount: 0, listFilesCount: 0,
      consecutiveDiscoveryWithoutWrite: 0,
      filesReadThisRun: new Map(), filesWrittenThisRun: new Set(),
    };
  }

  private getEffectivePath(originalPath: string): string {
    let cleanPath = originalPath;
    // Agents sometimes provide absolute paths like `/foo/bar.ts` assuming the root is `/`
    // Convert it to a relative path `foo/bar.ts` if it isn't an actual absolute OS path 
    if (path.isAbsolute(cleanPath) && !cleanPath.startsWith(this.workspaceRoot)) {
      cleanPath = cleanPath.replace(/^[\/\\]+/, '');
    }

    if (!this._activeSandbox) return cleanPath;

    if (path.isAbsolute(cleanPath)) {
      // Absolute paths not allowed to be re-mapped easily, but let's assume they are relative to workspaceRoot
      // The prompt tells Agents to use relative paths.
      const rel = path.relative(this.workspaceRoot, cleanPath);
      const sandboxRel = path.relative(this.workspaceRoot, this._activeSandbox.workspacePath);
      return path.join(sandboxRel, rel).replace(/\\/g, '/');
    }
    const sandboxRel = path.relative(this.workspaceRoot, this._activeSandbox.workspacePath);
    return path.join(sandboxRel, cleanPath).replace(/\\/g, '/');
  }

  /**
   * Dispatch a tool-use event to its handler.
   * Emits thought events for the call and result.
   * Returns the tool result text to append to the conversation.
   */
  async dispatch(
    toolEvent: { id: string; name: string; input: Record<string, unknown> },
    agentId: string,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    onThought: ThoughtCallback
  ): Promise<string> {
    onThought({
      type: 'tool_call',
      label: `Tool: ${toolEvent.name}`,
      detail: JSON.stringify(toolEvent.input, null, 2),
      timestamp: new Date(),
    });

    // ─── V2: .bormagi path blocking ──────────────────────────────────────────
    // Prevent agents from reading or writing the internal framework state directory.
    if (vscode.workspace.getConfiguration('bormagi').get<boolean>('executionEngineV2', false)) {
      const inp = toolEvent.input as Record<string, unknown>;
      const targetPath: string | undefined =
        (inp.path as string | undefined) ??
        (inp.directory as string | undefined) ??
        (inp.file_path as string | undefined);
      const EXEMPT_TOOLS = new Set(['update_task_state', 'declare_file_batch']);
      if (!EXEMPT_TOOLS.has(toolEvent.name) && targetPath) {
        const normalised = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (normalised.startsWith('.bormagi/') || normalised === '.bormagi') {
          const msg = getAppData().executionMessages.toolBlocked.bormagiPath;
          return msg;
        }
      }
    }

    // ─── V2: Phase 3 runtime guards ──────────────────────────────────────────
    if (this._guardState.useV2) {
      const msgs = getAppData().executionMessages.toolBlocked;
      const g = this._guardState;
      const inp = toolEvent.input as Record<string, unknown>;
      const targetPath = (inp.path as string | undefined) ??
        (inp.directory as string | undefined) ??
        (inp.file_path as string | undefined);
      const normPath = targetPath ? targetPath.replace(/\\/g, '/') : '';

      // Reread prevention: reject if file was already read and not written since
      if (toolEvent.name === 'read_file' && normPath) {
        const wasRead = g.filesReadThisRun.has(normPath);
        const wasWritten = g.filesWrittenThisRun.has(normPath);
        if (wasRead && !wasWritten) {
          return msgs.reread;
        }
      }

      // Discovery budget enforcement (code mode only)
      if (g.mode === 'code') {
        const READ_LIMIT = 3;
        const LIST_LIMIT = 2;
        const CONSEC_LIMIT = 3;
        const budgetExhausted =
          (toolEvent.name === 'read_file' && g.readFileCount >= READ_LIMIT) ||
          (toolEvent.name === 'list_files' && g.listFilesCount >= LIST_LIMIT) ||
          (g.consecutiveDiscoveryWithoutWrite >= CONSEC_LIMIT &&
            ['read_file', 'list_files', 'search_files'].includes(toolEvent.name));
        if (budgetExhausted) {
          return msgs.budgetExhausted;
        }
      }

      // Track counts for budget (done before dispatch so even blocked paths update state)
      if (toolEvent.name === 'read_file') { g.readFileCount++; g.consecutiveDiscoveryWithoutWrite++; }
      else if (toolEvent.name === 'list_files') { g.listFilesCount++; g.consecutiveDiscoveryWithoutWrite++; }
      else if (toolEvent.name === 'search_files') { g.consecutiveDiscoveryWithoutWrite++; }
      else if (['write_file', 'edit_file', 'run_command'].includes(toolEvent.name)) {
        g.consecutiveDiscoveryWithoutWrite = 0;
        if (normPath) { g.filesWrittenThisRun.add(normPath); }
      }

      // Mark file as read for reread prevention
      if (toolEvent.name === 'read_file' && normPath) {
        g.filesReadThisRun.set(normPath, Date.now());
      }
    }

    // Approval gate for sensitive tools
    const { approvalTools, toolServerMap } = getAppData();
    let approved = true;
    if (approvalTools.has(toolEvent.name)) {
      const inp = toolEvent.input as { command?: string; message?: string; title?: string; filename?: string };
      const detail = inp.command ?? inp.message ?? inp.filename ?? inp.title ?? JSON.stringify(toolEvent.input);
      const verb = (toolEvent.name === 'create_document' || toolEvent.name === 'create_presentation')
        ? 'create' : 'run';
      approved = await onApproval(`Agent wants to ${verb}:\n\n${detail}\n\nAllow?`);
      await this.auditLogger.logCommand(detail, agentId, approved);
    }

    let result: string;

    if (!approved) {
      result = 'User denied this action.';
    } else if (toolEvent.name === 'run_command' && this.execWrapper) {
      const inp = toolEvent.input as { command: string; cwd?: string };
      // Override cwd if sandboxed
      let cmd = inp.command;
      if (this._activeSandbox) {
        const sandboxRel = path.relative(this.workspaceRoot, this._activeSandbox.workspacePath);
        cmd = `cd ${sandboxRel} && ${cmd}`;
      }
      try {
        const res = await this.execWrapper.guardedCommand(
          'current-task',
          'local-user',
          this._activeSandbox ? 'local_worktree_sandbox' : 'host',
          cmd,
          'Requested by agent'
        );
        result = `Exit Code: ${res.exitCode}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`;
      } catch (err: any) {
        result = `Command failed: ${err.message}`;
      }
    } else if (toolEvent.name === 'write_file') {
      const inp = toolEvent.input as { path: string; content: string };
      const originalPath = inp.path;
      inp.path = this.getEffectivePath(inp.path);
      result = await this.handleWriteFile(
        agentId,
        inp,
        onDiff
      );

      // Mask the sandbox path prefix in the success response so the agent only sees its requested path
      if (this._activeSandbox) {
        const sandboxRel = path.relative(this.workspaceRoot, this._activeSandbox.workspacePath).replace(/\\/g, '/');
        result = result.replace(new RegExp(`File written: ${sandboxRel}[/\\\\]?`, 'g'), `File written: `)
          .replace(new RegExp(sandboxRel, 'g'), '');
      }
    } else if (toolEvent.name === 'get_diagnostics') {
      result = this.handleGetDiagnostics(toolEvent.input as { path?: string });
    } else if (toolEvent.name === 'create_document') {
      result = await this.handleCreateDocument(
        toolEvent.input as { filename: string; title?: string; content_markdown: string }
      );
    } else if (toolEvent.name === 'create_presentation') {
      result = await this.handleCreatePresentation(
        toolEvent.input as { filename: string; slides_markdown: string }
      );
    } else {
      const serverName = toolServerMap[toolEvent.name];
      if (serverName) {
        // Rewrite path for read/list tools dynamically if needed
        const inp = { ...toolEvent.input } as Record<string, any>;
        if (inp.path) inp.path = this.getEffectivePath(inp.path);
        if (inp.directory) inp.directory = this.getEffectivePath(inp.directory);

        const tc: MCPToolCall = { name: toolEvent.name, input: inp };
        const mcpResult = await this.mcpHost.callTool(serverName, tc);
        result = mcpResult.content.map(c => c.text).join('\n');

        // Strip sandbox prefix from search_files or list_files responses
        if (this._activeSandbox && (toolEvent.name === 'search_files' || toolEvent.name === 'list_files')) {
          const sandboxRel = path.relative(this.workspaceRoot, this._activeSandbox.workspacePath).replace(/\\/g, '/');
          // Lines in search_files look like: `.bormagi/sandboxes/sbx_.../workspace/src/foo.ts:1: content`
          result = result.replace(new RegExp(`${sandboxRel}[/\\\\]?`, 'g'), '');
        }
      } else {
        result = `Tool "${toolEvent.name}" not found in any running MCP server.`;
      }
    }

    onThought({
      type: 'tool_result',
      label: `Result: ${toolEvent.name}`,
      detail: result.slice(0, 500),
      timestamp: new Date(),
    });

    return result;
  }

  private async handleWriteFile(
    agentId: string,
    args: { path: string; content: string },
    onDiff: DiffCallback
  ): Promise<string> {
    const filePath = path.join(this.workspaceRoot, args.path);

    let originalContent = '';
    let fileExisted = false;
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      originalContent = Buffer.from(raw).toString('utf8');
      fileExisted = true;
    } catch {
      fileExisted = false;
    }

    let approved = false;
    // Bypass individual file approvals if we are operating purely inside an isolated sandbox
    if (this._activeSandbox) {
      approved = true;
    } else {
      const config = vscode.workspace.getConfiguration('bormagi');
      const requireConfirmation = config.get<boolean>('sandbox.requireConfirmation', false);

      if (!requireConfirmation) {
        approved = true; // Auto-approve by default when sandbox is disabled, as requested by user
      } else {
        approved = await onDiff(filePath, originalContent, args.content);
      }
    }

    if (!approved) {
      return 'User declined the file change.';
    }

    this.undoManager.recordFileWrite(agentId, filePath, originalContent, fileExisted);

    const mcpResult = await this.mcpHost.callTool('filesystem', {
      name: 'write_file',
      input: { path: args.path, content: args.content },
    });

    await this.auditLogger.logFileWrite(filePath, agentId);
    return mcpResult.content.map(c => c.text).join('\n');
  }

  private handleGetDiagnostics(args: { path?: string }): string {
    const SEVERITY = ['Error', 'Warning', 'Info', 'Hint'];
    const lines: string[] = [];

    if (args.path) {
      const uri = vscode.Uri.file(path.join(this.workspaceRoot, args.path));
      const diags = vscode.languages.getDiagnostics(uri);
      for (const d of diags) {
        lines.push(`${args.path} [${SEVERITY[d.severity] ?? d.severity}] ${d.message} (L${d.range.start.line + 1})`);
      }
    } else {
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        const rel = path.relative(this.workspaceRoot, uri.fsPath);
        for (const d of diags) {
          lines.push(`${rel} [${SEVERITY[d.severity] ?? d.severity}] ${d.message} (L${d.range.start.line + 1})`);
        }
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'No diagnostics found.';
  }

  private async handleCreateDocument(
    args: { filename: string; title?: string; content_markdown: string }
  ): Promise<string> {
    const safeName = path.basename(args.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalPath = path.join(this.workspaceRoot, safeName.endsWith('.docx') ? safeName : safeName + '.docx');
    try {
      await generateDocx(args.title ?? '', args.content_markdown, finalPath);
      return `Document created: ${path.basename(finalPath)}`;
    } catch (err) {
      return `Failed to create document: ${(err as Error).message}`;
    }
  }

  private async handleCreatePresentation(
    args: { filename: string; slides_markdown: string }
  ): Promise<string> {
    const safeName = path.basename(args.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalPath = path.join(this.workspaceRoot, safeName.endsWith('.pptx') ? safeName : safeName + '.pptx');
    try {
      await generatePptx(args.slides_markdown, finalPath);
      return `Presentation created: ${path.basename(finalPath)}`;
    } catch (err) {
      return `Failed to create presentation: ${(err as Error).message}`;
    }
  }
}
