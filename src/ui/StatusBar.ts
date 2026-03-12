import * as vscode from 'vscode';

export class StatusBar {
  private agentItem: vscode.StatusBarItem;
  private modeItem: vscode.StatusBarItem;

  constructor() {
    this.agentItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.agentItem.command = 'bormagi.selectAgent';
    this.agentItem.tooltip = 'Click to switch Bormagi agent';
    this.update(undefined);

    this.modeItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.modeItem.command = 'bormagi.switchMode';
    this.modeItem.tooltip = 'Click to switch assistant mode (Ask / Plan / Code)';
    this.modeItem.text = '$(symbol-misc) Ask';
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.agentItem);
    context.subscriptions.push(this.modeItem);
    this.agentItem.show();
    this.modeItem.show();
  }

  update(agentName: string | undefined): void {
    if (agentName) {
      this.agentItem.text = `$(robot) Bormagi: ${agentName}`;
    } else {
      this.agentItem.text = `$(robot) Bormagi`;
    }
  }

  updateMode(modeLabel: string): void {
    this.modeItem.text = `$(symbol-misc) ${modeLabel}`;
  }
}
