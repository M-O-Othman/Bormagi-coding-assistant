import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatController, MessageToWebview } from './ChatController';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml();

    // Register callback so controller can post messages to the webview
    this.controller.registerWebviewCallback((msg: MessageToWebview) => {
      webviewView.webview.postMessage(msg);
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message: { type: string; text?: string; agentId?: string }) => {
      if (message.type === 'user_message' && message.text) {
        await this.controller.handleUserMessage(message.text);
      } else if (message.type === 'refresh_agents') {
        await this.controller.refreshAgentList();
      } else if (message.type === 'select_agent' && message.agentId) {
        await this.controller.setActiveAgent(message.agentId);
      }
    });
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    try {
      return fs.readFileSync(htmlPath, 'utf8');
    } catch {
      return '<html><body><p>Bormagi: Could not load chat UI.</p></body></html>';
    }
  }
}
