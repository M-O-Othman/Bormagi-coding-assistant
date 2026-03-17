import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** Callback that posts an inline action card in the chat and returns the user's choice. */
export type InlineApprovalFn = (
  prompt: string,
  actions: string[],
  meta?: { kind?: 'edit' | 'command'; reason?: string; scope?: string[]; risk?: 'low' | 'medium' | 'high' }
) => Promise<string | undefined>;

/**
 * Shows a VS Code diff editor between the current file content and the proposed new content.
 * Approval is requested inline in the chat (not a modal popup).
 */
export class DiffManager {
  private inlineApproval: InlineApprovalFn | null = null;

  /** Set the inline approval function (provided by ChatController). */
  setInlineApproval(fn: InlineApprovalFn): void {
    this.inlineApproval = fn;
  }

  async showAndApprove(
    filePath: string,
    originalContent: string,
    newContent: string
  ): Promise<boolean> {
    const filename = path.basename(filePath);
    const tempDir = os.tmpdir();

    // Write the proposed content to a temp file for the right-hand side
    const tempPath = path.join(tempDir, `bormagi-proposed-${Date.now()}-${filename}`);
    fs.writeFileSync(tempPath, newContent, 'utf8');

    // Write original to a temp file for the left-hand side
    const originalTempPath = path.join(tempDir, `bormagi-original-${Date.now()}-${filename}`);
    fs.writeFileSync(originalTempPath, originalContent, 'utf8');

    const leftUri = vscode.Uri.file(originalTempPath);
    const rightUri = vscode.Uri.file(tempPath);

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `Bormagi: ${filename} (Original ↔ Proposed)`,
      { preview: true }
    );

    let choice: string | undefined;

    if (this.inlineApproval) {
      // Inline approval in chat
      choice = await this.inlineApproval(
        `Agent wants to modify **${filename}**. The diff is open in the editor — review it and choose an action.`,
        ['Apply', 'Discard'],
        { kind: 'edit', scope: [filePath], risk: 'low' }
      );
    } else {
      // Fallback to modal dialog if inline not available
      choice = await vscode.window.showInformationMessage(
        `Bormagi agent wants to modify ${filename}. Apply the change?`,
        { modal: true },
        'Apply',
        'Discard'
      );
    }

    // Clean up temp files
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    try { fs.unlinkSync(originalTempPath); } catch { /* ignore */ }

    return choice === 'Apply';
  }
}
