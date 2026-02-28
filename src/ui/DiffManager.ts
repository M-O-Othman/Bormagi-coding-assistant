import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Shows a VS Code diff editor between the current file content and the proposed new content.
 * Returns true if the user approves the change, false if they decline.
 */
export class DiffManager {
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

    const choice = await vscode.window.showInformationMessage(
      `Bormagi agent wants to modify ${filename}. Apply the change?`,
      { modal: true },
      'Apply',
      'Discard'
    );

    // Clean up temp files
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    try { fs.unlinkSync(originalTempPath); } catch { /* ignore */ }

    return choice === 'Apply';
  }
}
