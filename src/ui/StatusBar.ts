import * as vscode from 'vscode';

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'bormagi.selectAgent';
    this.item.tooltip = 'Click to switch Bormagi agent';
    this.update(undefined);
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.item);
    this.item.show();
  }

  update(agentName: string | undefined): void {
    if (agentName) {
      this.item.text = `$(robot) Bormagi: ${agentName}`;
    } else {
      this.item.text = `$(robot) Bormagi`;
    }
  }
}
