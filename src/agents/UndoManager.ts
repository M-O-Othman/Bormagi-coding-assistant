import * as vscode from 'vscode';
import { UndoAction } from '../types';

export class UndoManager {
  private stacks = new Map<string, UndoAction[]>();

  recordFileWrite(agentId: string, filePath: string, previousContent: string): void {
    this.push(agentId, {
      type: 'write_file',
      filePath,
      previousContent,
      description: `Wrote file: ${filePath}`,
      timestamp: new Date()
    });
  }

  recordCommand(agentId: string, command: string): void {
    this.push(agentId, {
      type: 'run_command',
      description: `Ran command: ${command}`,
      timestamp: new Date()
    });
  }

  async undo(agentId: string): Promise<string> {
    const stack = this.stacks.get(agentId);
    if (!stack || stack.length === 0) {
      return 'Nothing to undo.';
    }

    const action = stack.pop()!;

    if (action.type === 'write_file' && action.filePath !== undefined) {
      const uri = vscode.Uri.file(action.filePath);
      if (action.previousContent !== undefined) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(action.previousContent, 'utf8'));
        return `Undone: restored ${action.filePath} to its previous state.`;
      } else {
        // File was newly created — delete it
        try {
          await vscode.workspace.fs.delete(uri);
        } catch {
          // File may already be gone
        }
        return `Undone: deleted newly created file ${action.filePath}.`;
      }
    }

    if (action.type === 'run_command') {
      return `Note: terminal commands cannot be automatically reversed. The command was: ${action.description}`;
    }

    return `Undo action type "${action.type}" is not supported.`;
  }

  hasUndoable(agentId: string): boolean {
    const stack = this.stacks.get(agentId);
    return !!stack && stack.length > 0;
  }

  private push(agentId: string, action: UndoAction): void {
    if (!this.stacks.has(agentId)) {
      this.stacks.set(agentId, []);
    }
    this.stacks.get(agentId)!.push(action);
  }
}
