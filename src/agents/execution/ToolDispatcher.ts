import * as vscode from 'vscode';
import * as path from 'path';
import { MCPHost } from '../../mcp/MCPHost';
import { UndoManager } from '../UndoManager';
import { AuditLogger } from '../../audit/AuditLogger';
import { generateDocx, generatePptx } from '../../utils/DocumentGenerator';
import type { MCPToolCall, ThoughtEvent } from '../../types';
import { getAppData } from '../../data/DataStore';

export type ApprovalCallback = (prompt: string) => Promise<boolean>;
export type DiffCallback = (filePath: string, originalContent: string, newContent: string) => Promise<boolean>;
export type ThoughtCallback = (event: ThoughtEvent) => void;

/**
 * Dispatches agent tool calls to the appropriate MCP server or virtual handler.
 * Encapsulates approval gating, write-file diff flow, and document generation.
 */
export class ToolDispatcher {
  constructor(
    private readonly mcpHost: MCPHost,
    private readonly undoManager: UndoManager,
    private readonly auditLogger: AuditLogger,
    private readonly workspaceRoot: string
  ) {}

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
      type:      'tool_call',
      label:     `Tool: ${toolEvent.name}`,
      detail:    JSON.stringify(toolEvent.input, null, 2),
      timestamp: new Date(),
    });

    // Approval gate for sensitive tools
    const { approvalTools, toolServerMap } = getAppData();
    let approved = true;
    if (approvalTools.has(toolEvent.name)) {
      const inp = toolEvent.input as { command?: string; message?: string; title?: string; filename?: string };
      const detail = inp.command ?? inp.message ?? inp.filename ?? inp.title ?? JSON.stringify(toolEvent.input);
      const verb   = (toolEvent.name === 'create_document' || toolEvent.name === 'create_presentation')
        ? 'create' : 'run';
      approved = await onApproval(`Agent wants to ${verb}:\n\n${detail}\n\nAllow?`);
      await this.auditLogger.logCommand(detail, agentId, approved);
    }

    let result: string;

    if (!approved) {
      result = 'User denied this action.';
    } else if (toolEvent.name === 'write_file') {
      result = await this.handleWriteFile(
        agentId,
        toolEvent.input as { path: string; content: string },
        onDiff
      );
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
        const tc: MCPToolCall = { name: toolEvent.name, input: toolEvent.input };
        const mcpResult = await this.mcpHost.callTool(serverName, tc);
        result = mcpResult.content.map(c => c.text).join('\n');
      } else {
        result = `Tool "${toolEvent.name}" not found in any running MCP server.`;
      }
    }

    onThought({
      type:      'tool_result',
      label:     `Result: ${toolEvent.name}`,
      detail:    result.slice(0, 500),
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

    const approved = await onDiff(filePath, originalContent, args.content);
    if (!approved) {
      return 'User declined the file change.';
    }

    this.undoManager.recordFileWrite(agentId, filePath, originalContent, fileExisted);

    const mcpResult = await this.mcpHost.callTool('filesystem', {
      name:  'write_file',
      input: { path: args.path, content: args.content },
    });

    await this.auditLogger.logFileWrite(filePath, agentId);
    return mcpResult.content.map(c => c.text).join('\n');
  }

  private handleGetDiagnostics(args: { path?: string }): string {
    const SEVERITY = ['Error', 'Warning', 'Info', 'Hint'];
    const lines: string[] = [];

    if (args.path) {
      const uri   = vscode.Uri.file(path.join(this.workspaceRoot, args.path));
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
    const safeName  = path.basename(args.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
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
    const safeName  = path.basename(args.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalPath = path.join(this.workspaceRoot, safeName.endsWith('.pptx') ? safeName : safeName + '.pptx');
    try {
      await generatePptx(args.slides_markdown, finalPath);
      return `Presentation created: ${path.basename(finalPath)}`;
    } catch (err) {
      return `Failed to create presentation: ${(err as Error).message}`;
    }
  }
}
