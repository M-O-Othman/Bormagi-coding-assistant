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
import type { ExecutionStateData } from '../ExecutionStateManager';

export type ApprovalCallback = (prompt: string) => Promise<boolean>;
export type DiffCallback = (filePath: string, originalContent: string, newContent: string) => Promise<boolean>;
export type ThoughtCallback = (event: ThoughtEvent) => void;

/**
 * Structured result from ToolDispatcher.dispatch() — replaces plain string returns
 * so the controller can differentiate successful, blocked, and cached results
 * without parsing text (DD4).
 */
export interface DispatchResult {
  text: string;
  status: 'success' | 'blocked' | 'cached' | 'budget_exhausted';
  reasonCode?:
    | 'ALREADY_READ_UNCHANGED'
    | 'DISCOVERY_BUDGET_EXHAUSTED'
    | 'DISCOVERY_LOCKED'
    | 'INVALID_TOOL_PAYLOAD'
    | 'BATCH_REQUIRED'
    | 'BORMAGI_PATH_BLOCKED'
    | 'MODE_DISALLOWS_MUTATION'
    | 'LOOP_DETECTED'
    | 'WRITE_ONLY_PHASE'
    | 'BATCH_PREREQUISITE_MISSING';
  toolName: string;
  path?: string;
}

/** Per-run guard state tracked by ToolDispatcher for Phase 3 runtime enforcement. */
interface ToolGuardState {
  mode: string;
  useV2: boolean;
  /** Map from normalised path → cached content of last read. Cleared when file is written. */
  filesReadThisRun: Map<string, string>;
  /** Set of paths written this run — re-reading is allowed after a write. */
  filesWrittenThisRun: Set<string>;
  /** Hard lockout: after discovery budget exhaustion, block ALL discovery tools until a write succeeds. */
  discoveryLocked: boolean;
  /** FIX 3: Current execution sub-phase (WRITE_ONLY blocks all reads at dispatch level). */
  executionPhase?: string;
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
    discoveryLocked: false,
  };
  private _budget: DiscoveryBudget = new DiscoveryBudget();
  private _execState: ExecutionStateData | null = null;

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
      discoveryLocked: false,
    };
    this._budget = new DiscoveryBudget();
  }

  /**
   * Activate hard discovery lockout. All discovery tool calls (read_file, list_files,
   * search_files, etc.) will be rejected until a successful write/edit unlocks it.
   * Called from AgentRunner when discovery budget is exceeded.
   */
  public lockDiscovery(): void {
    this._guardState.discoveryLocked = true;
  }

  /** FIX 3: Set execution phase on guard state for dispatch-level enforcement. */
  public setExecutionPhase(phase: string): void {
    this._guardState.executionPhase = phase;
  }

  /**
   * Pre-populate the read cache from previous session's resolvedInputs.
   * This ensures reread prevention works across sessions — not just within one.
   * Files are marked as "read" with an empty string (content not available),
   * which is enough to trigger the [Cached] pointer on re-read attempts.
   * Called from AgentRunner after resetGuardState() when resuming.
   */
  public seedReadCache(filePaths: string[]): void {
    for (const fp of filePaths) {
      const normPath = fp.replace(/\\/g, '/');
      this._guardState.filesReadThisRun.set(normPath, '');
    }
  }

  /**
   * Cache the content of a successful read_file result so that subsequent
   * reread attempts return the cached content instead of a BLOCKED message.
   * Called from AgentRunner after a successful read_file dispatch.
   */
  public cacheReadResult(filePath: string, content: string): void {
    const normPath = filePath.replace(/\\/g, '/');
    this._guardState.filesReadThisRun.set(normPath, content);
  }

  /**
   * Wire the dispatcher to the authoritative cross-session execution state.
   * The primary reread check consults execState.resolvedInputs (persisted across
   * sessions); the runtime cache is a secondary in-session fast path.
   */
  public setExecutionState(state: ExecutionStateData): void {
    this._execState = state;
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
   * Returns a structured DispatchResult (DD4) so the controller can
   * differentiate success, blocked, and cached outcomes without parsing text.
   */
  async dispatch(
    toolEvent: { id: string; name: string; input: Record<string, unknown> },
    agentId: string,
    onApproval: ApprovalCallback,
    onDiff: DiffCallback,
    onThought: ThoughtCallback
  ): Promise<DispatchResult> {
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
      // Allow WRITES to .bormagi/plans/ for plan documents (.md/.txt) — plans are agent output.
      // READS of .bormagi/plans/ are BLOCKED in code mode — plan content should be normalized
      // into execution state, not re-read repeatedly (prevents loop-detected read cycles).
      const isBormagiPlansAccess = (p: string, tool: string) => {
        const n = p.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!n.startsWith('.bormagi/plans')) { return false; }
        // In code mode, block reads of .bormagi/plans/ — plan is already in execution state
        if (this._guardState.mode === 'code' && (tool === 'read_file' || tool === 'list_files')) { return false; }
        // In plan mode, allow reads for plan authoring
        if (tool === 'list_files' || tool === 'read_file') { return true; }
        if (tool !== 'write_file' && tool !== 'edit_file') { return false; }
        const ext = n.split('.').pop()?.toLowerCase() ?? '';
        return ['md', 'txt', 'rst'].includes(ext);
      };
      if (!EXEMPT_TOOLS.has(toolEvent.name)) {
        if (targetPath && isBormagiPath(targetPath) && !isBormagiPlansAccess(targetPath, toolEvent.name)) {
          return { text: getAppData().executionMessages.toolBlocked.bormagiPath, status: 'blocked', reasonCode: 'BORMAGI_PATH_BLOCKED', toolName: toolEvent.name, path: targetPath };
        }
        // For multi_edit: check every edit's path
        if (toolEvent.name === 'multi_edit') {
          const edits = inp.edits as Array<{ path: string }> | undefined;
          if (Array.isArray(edits) && edits.some(e => isBormagiPath(e.path))) {
            return { text: getAppData().executionMessages.toolBlocked.bormagiPath, status: 'blocked', reasonCode: 'BORMAGI_PATH_BLOCKED', toolName: toolEvent.name };
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
            return { text: modeDisallowsMsg.replace('{mode}', 'plan'), status: 'blocked', reasonCode: 'MODE_DISALLOWS_MUTATION', toolName: toolEvent.name };
          }
        } else {
          const modeDisallowsMsg: string = (getAppData().executionMessages.toolBlocked as Record<string, string>).modeDisallowsMutation
            ?? `[BLOCKED] Mode '${this._guardState.mode}' does not permit file mutations. Switch to Code mode to make changes.`;
          return { text: modeDisallowsMsg.replace('{mode}', this._guardState.mode), status: 'blocked', reasonCode: 'MODE_DISALLOWS_MUTATION', toolName: toolEvent.name };
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

      // Reread prevention: consult BOTH the persisted execution state (cross-session)
      // and the runtime cache (within-session). The execState is authoritative;
      // the runtime cache is a fast path for content retrieval.
      // After recovery, resetGuardState() clears the runtime cache so the next
      // read goes through MCP normally.
      if (toolEvent.name === 'read_file' && normPath) {
        const wasWritten = g.filesWrittenThisRun.has(normPath);
        if (!wasWritten) {
          // Primary check: cross-session resolvedInputs via execState
          const inExecState = this._execState?.resolvedInputs.includes(normPath) ?? false;
          // Secondary check: runtime cache (within-session)
          const cachedContent = g.filesReadThisRun.get(normPath);
          if (cachedContent !== undefined || inExecState) {
            // Increment blockedReadCount so REPEATED_BLOCKED_READS recovery fires
            if (this._execState) {
              this._execState.blockedReadCount = (this._execState.blockedReadCount ?? 0) + 1;
            }

            // Return cached content if available — highest-impact fix: converts
            // blocked reads from "zero information" to "full information"
            if (cachedContent) {
              return {
                text: `[FROM CACHE — "${normPath}" already read, content below. Do not call read_file again.]\n${cachedContent}`,
                status: 'cached',
                reasonCode: 'ALREADY_READ_UNCHANGED',
                toolName: 'read_file',
                path: normPath,
              };
            }

            // No cached content available — use the original rejection
            return {
              text: `[ALREADY READ] "${normPath}" was read earlier this session. Content is not cached. Write a file now — do not re-read.`,
              status: 'cached',
              reasonCode: 'ALREADY_READ_UNCHANGED',
              toolName: 'read_file',
              path: normPath,
            };
          }
        }
      }

      // FIX 3c: WRITE_ONLY phase enforcement — reject ALL reads when in WRITE_ONLY phase.
      // This is a hard state-machine gate, not an advisory text warning.
      const DISCOVERY_TOOLS = new Set(['read_file', 'read_file_range', 'read_head', 'read_tail',
        'read_match_context', 'read_symbol_block', 'list_files', 'glob_files',
        'search_files', 'grep_content']);
      if (g.executionPhase === 'WRITE_ONLY' && DISCOVERY_TOOLS.has(toolEvent.name)) {
        return {
          text: '[REJECTED] Phase is WRITE_ONLY. Only write_file, edit_file, and run_command are allowed. Write the next file now.',
          status: 'blocked',
          reasonCode: 'WRITE_ONLY_PHASE',
          toolName: toolEvent.name,
          path: normPath || undefined,
        };
      }

      // Discovery lockout: after budget exhaustion, hard-block ALL discovery tools
      // until a successful write/edit unlocks discovery. This prevents infinite
      // read→budget_warning→read loops that freeze the agent.
      if (g.discoveryLocked && DISCOVERY_TOOLS.has(toolEvent.name)) {
        return {
          text: '[DISCOVERY LOCKED] Discovery budget exhausted. You must write or edit a file before any further reads/searches. Call write_file or edit_file now.',
          status: 'blocked',
          reasonCode: 'DISCOVERY_LOCKED',
          toolName: toolEvent.name,
        };
      }

      // Discovery budget enforcement (code mode only)
      if (g.mode === 'code') {
        const category = toolCategory(toolEvent.name);
        const check = this._budget.record(category);
        if (!check.allowed) {
          // Activate hard lockout — no more discovery until a write succeeds
          g.discoveryLocked = true;
          const hint = check.suggestion ? `\n${check.suggestion}` : '';
          return { text: `${check.reason ?? msgs.budgetExhausted}${hint}`, status: 'budget_exhausted', reasonCode: 'DISCOVERY_BUDGET_EXHAUSTED', toolName: toolEvent.name };
        }
      } else {
        // Still track writes/validates for reread prevention in non-code modes
        const category = toolCategory(toolEvent.name);
        if (category === 'write_or_edit' || category === 'validate') {
          this._budget.record(category);
        }
      }

      // File-level read tracking is done via cacheReadResult() called from
      // AgentRunner AFTER successful dispatch — not here. This ensures we only
      // cache content from successful reads, not failed ones.
      if (['write_file', 'edit_file'].includes(toolEvent.name) && normPath) {
        g.filesWrittenThisRun.add(normPath);
      }
    }

    // ─── V2: Block unnecessary shell inspection when execution state is sufficient ──
    // If the agent already knows a file exists (via artifact registry / resolvedInputs),
    // reject shell inspection commands like `ls`, `dir`, `stat`, `cat`, `type` that
    // just check file existence or content. Also reject Unix commands on Windows hosts.
    if (this._guardState.useV2 && toolEvent.name === 'run_command') {
      const inp = toolEvent.input as { command: string };
      const cmd = (inp.command ?? '').trim();

      // Block Unix-only commands on Windows (platform awareness)
      const isWindows = process.platform === 'win32';
      const UNIX_ONLY_INSPECTION = /^(ls|cat|head|tail|stat|file|wc|rm|cp|mv|touch|find|grep)\b|^mkdir\s+-p\b/;
      if (isWindows && UNIX_ONLY_INSPECTION.test(cmd)) {
        return {
          text: `[BLOCKED] Unix command syntax "${cmd.split(/\s/)[0]}" is not available on this Windows host. Use Windows cmd.exe equivalents (e.g. drop '-p' from mkdir, use 'del'/'rmdir' instead of 'rm').`,
          status: 'blocked',
          reasonCode: 'WRITE_ONLY_PHASE',
          toolName: 'run_command',
        };
      }

      // Block file-inspection commands when execution state already has the answer
      const INSPECTION_PATTERNS = /^(ls|dir|cat|type|head|tail|stat|file|wc)(\s|$)/;
      if (this._execState && INSPECTION_PATTERNS.test(cmd)) {
        const hasArtifacts = this._execState.artifactsCreated.length > 0;
        const hasInputs = this._execState.resolvedInputs.length > 0;
        if (hasArtifacts || hasInputs) {
          return {
            text: `[BLOCKED] Shell inspection is unnecessary — the execution state already tracks file existence. Known artifacts: [${this._execState.artifactsCreated.join(', ')}]. Write or edit a file instead.`,
            status: 'blocked',
            reasonCode: 'WRITE_ONLY_PHASE',
            toolName: 'run_command',
          };
        }
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

    const normTargetPath = ((toolEvent.input as Record<string, unknown>).path as string | undefined)?.replace(/\\/g, '/');
    if (!approved) {
      result = 'User denied this action.';
    } else if (toolEvent.name === 'run_command' && this.execWrapper) {
      const inp = toolEvent.input as { command: string; cwd?: string };
      // Override cwd if sandboxed
      let cmd = inp.command;
      
      // Bug-Fix 11: Intercept mkdir to use FsOps.ensureDir
      const trimmedCmd = cmd.trim();
      if (trimmedCmd.startsWith('mkdir')) {
        const dirs = trimmedCmd.replace(/mkdir\s+-p?\s+/i, '').split(/\s+/);
        try {
          const { FsOps } = await import('../../utils/fsOps.js');
          await Promise.all(dirs.map(d => {
            const target = this._activeSandbox 
              ? path.join(this._activeSandbox.workspacePath, d)
              : path.join(this.workspaceRoot, d);
            return FsOps.ensureDir(target);
          }));
          result = `Exit Code: 0\nSTDOUT:\nDirectories created via FsOps.\nSTDERR:\n`;
        } catch (err: any) {
          result = `Command failed: ${err.message}`;
        }
      } else {
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
      }
    } else if (toolEvent.name === 'write_file') {
      const inp = toolEvent.input as { path: string; content: string };
      // Payload validation: reject malformed write_file calls before they reach the filesystem.
      // DD9 direct dispatch and recovery paths can produce { path } with no content.
      if (typeof inp.path !== 'string' || !inp.path) {
        return { text: '[INVALID_PAYLOAD] write_file requires a non-empty "path" string.', status: 'blocked', reasonCode: 'INVALID_TOOL_PAYLOAD', toolName: 'write_file' };
      }
      if (typeof inp.content !== 'string') {
        return { text: `[INVALID_PAYLOAD] write_file requires a "content" string for "${inp.path}". The content field was missing or undefined. Generate the file content and try again.`, status: 'blocked', reasonCode: 'INVALID_TOOL_PAYLOAD', toolName: 'write_file', path: inp.path };
      }
      inp.path = this.getEffectivePath(inp.path);

      // ─── V2: artifact-aware write→edit redirect ───────────────────────────
      // If the target file already exists (in the artifact registry or on disk),
      // redirect write_file to edit_file so an existing file is never silently
      // overwritten with a full rewrite. Returns a structured result so the agent
      // knows the redirect occurred (EQ-19, Option D).
      if (vscode.workspace.getConfiguration('bormagi').get<boolean>('executionEngineV2', false)) {
        const alreadyExists = await this._artifactExists(inp.path);
        if (alreadyExists) {
          // Check if edit_file is available in MCP before attempting redirect.
          // If edit_file is not registered, fall through to normal write_file handling
          // instead of failing with "Unknown tool: edit_file".
          const toolServerMap = getAppData().toolServerMap ?? {};
          if (toolServerMap['edit_file']) {
            try {
              const mcpResult = await this.mcpHost.callTool(toolServerMap['edit_file'], {
                name: 'edit_file',
                input: { path: inp.path, content: inp.content },
              });
              await this.auditLogger.logFileWrite(path.join(this.workspaceRoot, inp.path), agentId);
              const innerResult = mcpResult.content.map((c: any) => c.text).join('\n');
              result = innerResult; // SILENT patch
              onThought({
                type: 'tool_result',
                label: `Result: write_file (silently patched via edit_file)`,
                detail: result.slice(0, 500),
                timestamp: new Date(),
              });
              return { text: result, status: 'success', toolName: 'edit_file', path: inp.path };
            } catch {
              // edit_file call failed — fall through to normal write_file
            }
          }
          // edit_file not available or failed — fall through to normal write_file
          // with controller-approved overwrite. Set execution state to reflect
          // that this is a deliberate overwrite, not free-form planning.
          if (this._execState) {
            // Normalize mutation: write_file overwrite is the concrete fallback
            this._execState.nextActions = [`Overwrite "${inp.path}" via write_file (edit_file unavailable)`];
            this._execState.nextToolCall = undefined; // clear stale edit_file hints
          }
          onThought({
            type: 'thinking',
            label: `[Redirect skipped] edit_file unavailable — writing "${inp.path}" via write_file`,
            timestamp: new Date(),
          });
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

    // Unlock discovery after any successful mutation — the agent made progress.
    const MUTATION_TOOL_NAMES = new Set(['write_file', 'edit_file', 'replace_range', 'multi_edit',
      'find_and_replace_symbol_block', 'insert_after_symbol_block']);
    if (this._guardState.discoveryLocked && MUTATION_TOOL_NAMES.has(toolEvent.name)) {
      this._guardState.discoveryLocked = false;
    }

    onThought({
      type: 'tool_result',
      label: `Result: ${toolEvent.name}`,
      detail: result.slice(0, 500),
      timestamp: new Date(),
    });

    return { text: result, status: 'success', toolName: toolEvent.name, path: normTargetPath };
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
