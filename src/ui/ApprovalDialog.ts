import * as vscode from 'vscode';

export class ApprovalDialog {
  async request(prompt: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      prompt,
      { modal: true },
      'Allow',
      'Deny'
    );
    return choice === 'Allow';
  }
}
