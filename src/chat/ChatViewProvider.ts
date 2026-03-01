import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatController, MessageToWebview } from './ChatController';
import { getAppData } from '../data/DataStore';

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

    // Subscribe so controller can post messages to the webview
    this.controller.addSubscriber((msg: MessageToWebview) => {
      webviewView.webview.postMessage(msg);
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
      const type = message.type as string;
      if (type === 'user_message' && message.text) {
        await this.controller.handleUserMessage(message.text as string);
      } else if (type === 'refresh_agents') {
        await this.controller.refreshAgentList();
      } else if (type === 'select_agent' && message.agentId) {
        await this.controller.setActiveAgent(message.agentId as string);
      } else if (type === 'switch_model') {
        await this.controller.handleWebviewMessage(message);
      } else if (type === 'open_dashboard') {
        await vscode.commands.executeCommand('bormagi.openDashboard');
      } else if (type === 'open_meeting') {
        await vscode.commands.executeCommand('bormagi.startMeeting');
      } else if (type === 'open_agent_settings') {
        await vscode.commands.executeCommand('bormagi.openSettings');
      }
    });
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
    try {
      const raw = fs.readFileSync(htmlPath, 'utf8');
      // Inject model context limits from the shared constants so chat.html
      // never needs its own hardcoded copy.
      return raw.replace(
        /\/\*__MODEL_CONTEXT_LIMITS_JSON__\*\/\{\}\/\*__END__\*\//,
        JSON.stringify(getAppData().contextLimits)
      );
    } catch {
      return '<html><body><p>Bormagi: Could not load chat UI.</p></body></html>';
    }
  }
}
