import * as vscode from 'vscode';
import * as path from 'path';
import { MCPHost } from '../../mcp/MCPHost';
import { UndoManager } from '../UndoManager';
import { AuditLogger } from '../../audit/AuditLogger';
import { generateDocx, generatePptx } from '../../utils/DocumentGenerator';
import type { MCPToolCall, ThoughtEvent } from '../../types';
import { getAppData } from '../../data/DataStore';
import { DiscoveryBudget, toolCategory } from './DiscoveryBudget';

import { ExecWrapper } from '../../sandbox/ExecWrapper';
import { SandboxHandle } from '../../sandbox/types';

export type ApprovalCallback = (prompt: string) => Promise<boolean>;
export type DiffCallback = (filePath: string, originalContent: string, newContent: string) => Promise<boolean>;
export type ThoughtCallback = (event: ThoughtEvent) => void;

/** Per-run guard state tracked by ToolDispatcher for Phase 3 runtime enforcement. */
interface ToolGuardState {
  mode: string;
  useV2: boolean;
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
    mode: '', useV2: false,
    filesReadThisRun: new Map(), filesWrittenThisRun: new Set(),
  };
  private _budget: DiscoveryBudget = new DiscoveryBudget();

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
      mode, useV2,
      filesReadThisRun: new Map(), filesWrittenThisRun: new Set(),
    };
    this._budget = new DiscoveryBudget();
  }

  /** Returns the current discovery budget telemetry for audit/logging. */
  public getBudgetTelemetry() {
    return this._budget.getState();
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
        (inp.file_path as string | undefined) ??
        // For glob_files: also check the pattern field (e.g. pattern: '.bormagi/**')
        (toolEvent.name === 'glob_files' ? (inp.pattern as string | undefined) : undefined);
      const EXEMPT_TOOLS = new Set(['update_task_state', 'declare_file_batch']);
      const isBormagiPath = (p: string) => {
        const n = p.replace(/\\/g, '/').replace(/^\/+/, '');
        return n.startsWith('.bormagi/') || n === '.bormagi';
      };
      // Allow writes to .bormagi/plans/ for plan documents (.md/.txt).
      // Plans are agent output, not framework state.
      const isBormagiPlansWrite = (p: string, tool: string) => {
        if (tool !== 'write_file' && tool !== 'edit_file') { return false; }
        const n = p.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!n.startsWith('.bormagi/plans/')) { return false; }
        const ext = n.split('.').pop()?.toLowerCase() ?? '';
        return ['md', 'txt', 'rst'].includes(ext);
      };
      if (!EXEMPT_TOOLS.has(toolEvent.name)) {
        if (targetPath && isBormagiPath(targetPath) && !isBormagiPlansWrite(targetPath, toolEvent.name)) {
          return getAppData().executionMessages.toolBlocked.bormagiPath;
        }
        // For multi_edit: check every edit's path
        if (toolEvent.name === 'multi_edit') {
          const edits = inp.edits as Array<{ path: string }> | undefined;
          if (Array.isArray(edits) && edits.some(e => isBormagiPath(e.path))) {
            return getAppData().executionMessages.toolBlocked.bormagiPath;
          }
        }
      }
    }

    // ─── Phase 6: Mutation-tool blocking in read-only modes ─────────────────
    // Block write/edit tools in ask and plan modes at the transport layer.
    // ContextEnvelope already zeroes editable files for these modes, but this
    // is a second hard guard so rogue prompts cannot bypass it (PQ-10 Option A).
    if (this._guardState.useV2 && (this._guardState.mode === 'ask' || this._guardState.mode === 'plan')) {
      const MUTATION_TOOLS_READONLY = new Set([
        'write_file', 'edit_file', 'replace_range', 'multi_edit',
        'find_and_replace_symbol_block', 'insert_after_symbol_block',
        'create_document', 'create_presentation',
      ]);
      if (MUTATION_TOOLS_READONLY.has(toolEvent.name)) {
        // Plan mode: allow writing documentation files (.md, .txt, .rst).
        // A plan agent's primary output IS a written plan document.
        if (this._guardState.mode === 'plan' &&
            (toolEvent.name === 'write_file' || toolEvent.name === 'edit_file')) {
          const targetPath = ((toolEvent.input as Record<string, unknown>).path as string | undefined) ?? '';
          const ext = targetPath.split('.').pop()?.toLowerCase() ?? '';
          if (['md', 'txt', 'rst'].includes(ext)) {
            // Allow — fall through to normal dispatch
          } else {
            const modeDisallowsMsg: string = (getAppData().executionMessages.toolBlocked as Record<string, string>).modeDisallowsMutation
              ?? `[BLOCKED] Mode 'plan' does not permit writing source files. Switch to Code mode to make changes.`;
            return modeDisallowsMsg.replace('{mode}', 'plan');
          }
        } else {
          const modeDisallowsMsg: string = (getAppData().executionMessages.toolBlocked as Record<string, string>).modeDisallowsMutation
            ?? `[BLOCKED] Mode '${this._guardState.mode}' does not permit file mutations. Switch to Code mode to make changes.`;
          return modeDisallowsMsg.replace('{mode}', this._guardState.mode);
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
        const category = toolCategory(toolEvent.name);
        const check = this._budget.record(category);
        if (!check.allowed) {
          const hint = check.suggestion ? `\n${check.suggestion}` : '';
          return `${check.reason ?? msgs.budgetExhausted}${hint}`;
        }
      } else {
        // Still track writes/validates for reread prevention in non-code modes
        const category = toolCategory(toolEvent.name);
        if (category === 'write_or_edit' || category === 'validate') {
          this._budget.record(category);
        }
      }

      // Track file-level reread state
      if (toolEvent.name === 'read_file' && normPath) {
        g.filesReadThisRun.set(normPath, Date.now());
      }
      if (['write_file', 'edit_file'].includes(toolEvent.name) && normPath) {
        g.filesWrittenThisRun.add(normPath);
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
      inp.path = this.getEffectivePath(inp.path);

      // ─── V2: artifact-aware write→edit redirect ───────────────────────────
      // If the target file already exists (in the artifact registry or on disk),
      // redirect write_file to edit_file so an existing file is never silently
      // overwritten with a full rewrite. Returns a structured result so the agent
      // knows the redirect occurred (EQ-19, Option D).
      if (vscode.workspace.getConfiguration('bormagi').get<boolean>('executionEngineV2', false)) {
        const alreadyExists = await this._artifactExists(inp.path);
        if (alreadyExists) {
          // Redirect: call edit_file via MCP instead of write_file
          const mcpResult = await this.mcpHost.callTool('filesystem', {
            name: 'edit_file',
            input: { path: inp.path, content: inp.content },
          });
          await this.auditLogger.logFileWrite(path.join(this.workspaceRoot, inp.path), agentId);
          const msgs = getAppData().executionMessages as any;
          const redirectMsg = (msgs.artifactRedirect?.redirectedWriteToEdit ?? 'Redirected write_file to edit_file for existing file: {path}')
            .replace('{path}', inp.path);
          const innerResult = mcpResult.content.map((c: any) => c.text).join('\n');
          result = `${innerResult}\n[redirected: write_file → edit_file | ${redirectMsg}]`;
          onThought({
            type: 'tool_result',
            label: `Result: write_file (redirected to edit_file)`,
            detail: result.slice(0, 500),
            timestamp: new Date(),
          });
          return result;
        }
      }

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

  /**
   * Check if a path already exists in the artifact registry or on disk.
   * Used by the write→edit redirect guard.
   * @param relativePath - path relative to workspaceRoot
   */
  private async _artifactExists(relativePath: string): Promise<boolean> {
    const absPath = path.join(this.workspaceRoot, relativePath);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
      return true;
    } catch {
      return false;
    }
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
